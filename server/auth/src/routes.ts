import type { AuthActivity } from "./activity.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecurityOverview, SignInState, SocialProvider } from "@osiris/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type Provider from "oidc-provider";
import { z } from "zod";
import { HttpError, requestLocale, translate, ValidationError } from "@osiris/platform/i18n.ts";
import { readAll } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/db.ts";
import type { Clients } from "./clients.ts";
import type { Users } from "./users.ts";
import { CredentialError, type Credentials } from "./credentials.ts";
import type { AttemptLimiter } from "./limiter.ts";
import type { Mailer } from "@osiris/platform/mail.ts";
import type { Passkeys } from "./passkeys.ts";
import { newToken, passwordProblem, PASSWORD_MAX } from "./secrets.ts";
import { SOCIAL_PROVIDERS, SocialLoginError, type SocialLogin, type SocialProviderId } from "./social.ts";

export interface AuthDeps {
  db: Db;
  activity: AuthActivity;
  provider: Provider;
  users: Users;
  credentials: Credentials;
  passkeys: Passkeys;
  social: SocialLogin;
  mailer?: Mailer;
  limiter: AttemptLimiter;
  /** Registered applications. */
  clients: Clients;
  /** The identity provider's origin. */
  issuer: string;
  /** The name users see. */
  appName: string;
  /** Members administer the identity provider. */
  adminGroup: string;
}

/** A sign-in waiting for its second factor (authenticator app or recovery code). */
interface PendingSecondFactor {
  userId: string;
  amr: string[];
}

/** A redirect to a social provider in progress: back into a sign-in (`uid`) or linking to a signed-in user. */
interface SocialState {
  provider: SocialProviderId;
  nonce: string;
  verifier: string;
  uid?: string;
  linkUser?: string;
}

const STEP_TTL_MS = 10 * 60_000;
const LINK_COOKIE = "osiris_link";
const LINK_COOKIE_PATH = "/interaction";
const EMAIL_LINK_HOURS = 1;

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
};
const body = async <T>(c: Context, schema: z.ZodType<T>) =>
  parse(
    schema,
    await c.req.json().catch(() => {
      throw new HttpError(400, "errors.invalidJson");
    }),
  );

const email = z.email().max(200);
const password = z.string().min(1).max(PASSWORD_MAX);
const code = z.string().trim().min(6).max(20);
const passkeyResponse = z.looseObject({ id: z.string().min(1).max(1024), type: z.literal("public-key"), response: z.looseObject({}) });

/** Only paths on our own origin, so a return address can never send the browser elsewhere. */
const relative = (url: string) => {
  const u = new URL(url, "http://x");
  return `${u.pathname}${u.search}`;
};

/** The first address of X-Forwarded-For (set by Traefik, passed on by the gateway). */
export const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

/**
 * oidc-provider reads its cookies from Node's request; ours arrive through Hono. It only needs the headers, so a
 * request stand-in carries them (the response is never written: results go back as our own response).
 */
export const nodePair = (c: Context) => {
  const url = new URL(c.req.url);
  const req = { headers: Object.fromEntries(c.req.raw.headers), url: url.pathname + url.search, method: c.req.method, socket: {} };
  const res = { getHeader: () => undefined, setHeader: () => {}, removeHeader: () => {}, headersSent: false };
  return [req as unknown as IncomingMessage, res as unknown as ServerResponse] as const;
};

const isProvider = (p: string): p is SocialProviderId => (SOCIAL_PROVIDERS as readonly string[]).includes(p);

export class SignInError extends HttpError {}

/** A message in the language of the request (for redirects that carry it to the sign-in page). */
const say = (c: Context, key: string) => translate(requestLocale(c.req.header("accept-language")), key);

/**
 * The sign-in API (our `/login` page calls it), plus the redirects of social
 * sign-in, one-time links and profile pictures. Every step is bound to the browser's interaction cookie, which
 * oidc-provider set when the sign-in started.
 */
export function authRoutes(deps: AuthDeps) {
  const { provider, users, credentials, passkeys, social, limiter } = deps;

  /** The interaction of the URL, checked against the browser's cookie. */
  const interaction = async (c: Context) => {
    const [req, res] = nodePair(c);
    const details = await provider.interactionDetails(req, res).catch(() => {
      throw new SignInError(400, "errors.signIn.expired");
    });
    if (details.uid !== c.req.param("uid")) throw new SignInError(400, "errors.signIn.expired");
    return details;
  };

  /** Ends the sign-in step as `userId`; where the browser goes next (back to the authorization). */
  const finish = async (c: Context, userId: string, amr: string[]) => {
    const [req, res] = nodePair(c);
    const returnTo = await provider.interactionResult(req, res, { login: { accountId: userId, amr, remember: true } }, { mergeWithLastSubmission: false });
    await deps.db.execute([run("UPDATE users SET last_login_at = ? WHERE id = ?", Date.now(), userId)]);
    await deps.activity.record(userId, true, amr.join("+"), clientIp(c), c.req.header("user-agent") ?? "");
    return relative(returnTo);
  };

  /** After the first factor: on to the second if the user has one, otherwise signed in. */
  const firstFactorDone = async (c: Context, uid: string, userId: string, amr: string[]): Promise<{ redirectTo: string } | { step: "second-factor" }> => {
    if (await credentials.hasTotp(userId)) {
      await credentials.putChallenge(`second-factor:${uid}`, { userId, amr } satisfies PendingSecondFactor, STEP_TTL_MS);
      return { step: "second-factor" };
    }
    return { redirectTo: await finish(c, userId, amr) };
  };

  const activeUser = async (userId: string) => {
    const user = await users.get(userId).catch(() => null);
    return user && !user.disabled ? user : null;
  };

  const loginPage = (uid: string, extra: Record<string, string> = {}) => `/login?${new URLSearchParams({ uid, ...extra })}`;

  return (
    new Hono()
      // The browser lands here from the authorization endpoint (and from social sign-in and links).
      .get("/interaction/:uid", async (c) => {
        const details = await interaction(c);
        const uid = details.uid;
        if (details.prompt.name === "consent") {
          // Only our own web app exists: grant what it asked for.
          const accountId = details.session?.accountId;
          if (!accountId) throw new SignInError(400, "errors.signIn.expired");
          const grant = (details.grantId && (await provider.Grant.find(details.grantId))) || new provider.Grant({ accountId, clientId: String(details.params.client_id) });
          const missing = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] };
          if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
          if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
          const grantId = await grant.save();
          const [req, res] = nodePair(c);
          const returnTo = await provider.interactionResult(req, res, { consent: details.grantId ? {} : { grantId } }, { mergeWithLastSubmission: true });
          return c.redirect(relative(returnTo), 303);
        }
        // A one-time link opened in this browser signs the user in (the second factor still applies).
        const token = getCookie(c, LINK_COOKIE);
        if (token) {
          deleteCookie(c, LINK_COOKIE, { path: LINK_COOKIE_PATH });
          const link = await credentials.takeLink(token);
          const user = link && (await activeUser(link.userId));
          if (!link || !user) return c.redirect(loginPage(uid, { error: say(c, "errors.signIn.linkInvalid") }), 303);
          if (link.purpose === "email") await users.markEmailVerified(user.id);
          const next = await firstFactorDone(c, uid, user.id, ["link"]);
          return c.redirect("redirectTo" in next ? next.redirectTo : loginPage(uid), 303);
        }
        return c.redirect(loginPage(uid), 303);
      })

      .get("/interaction/:uid/state", async (c) => {
        const details = await interaction(c);
        const pending = await credentials.peekChallenge<PendingSecondFactor>(`second-factor:${details.uid}`);
        const app = await deps.clients.get(String(details.params.client_id));
        return c.json<SignInState>({
          step: pending ? "second-factor" : "login",
          methods: { passkey: true, emailLink: !!deps.mailer, social: social.enabled() },
          client: { name: app?.name ?? deps.appName, logo: app?.logo ?? null },
        });
      })

      .post("/interaction/:uid/password", async (c) => {
        const details = await interaction(c);
        const input = await body(c, z.object({ email, password }));
        const keys = [`ip:${clientIp(c)}`, `email:${input.email.toLowerCase()}`];
        if (limiter.blocked(keys)) throw new SignInError(429, "errors.signIn.tooManyAttempts");
        const userId = await credentials.checkPassword(input.email, input.password);
        if (!userId) {
          limiter.fail(keys);
          const account = (await deps.db.query<{ id: string }>("SELECT id FROM users WHERE lower(email)=?", [input.email.toLowerCase()]))[0];
          if (account) await deps.activity.record(account.id, false, "pwd", clientIp(c), c.req.header("user-agent") ?? "");
          throw new SignInError(401, "errors.signIn.wrongPassword");
        }
        limiter.reset([keys[1]!]);
        return c.json(await firstFactorDone(c, details.uid, userId, ["pwd"]));
      })

      .post("/interaction/:uid/second-factor", async (c) => {
        const details = await interaction(c);
        const input = await body(c, z.object({ code }));
        const key = `second-factor:${details.uid}`;
        const pending = await credentials.peekChallenge<PendingSecondFactor>(key);
        if (!pending) throw new SignInError(400, "errors.signIn.expired");
        const keys = [`second-factor-user:${pending.userId}`, `ip:${clientIp(c)}`];
        if (limiter.blocked(keys)) throw new SignInError(429, "errors.signIn.tooManyAttempts");
        const digits = input.code.replace(/\s/g, "");
        const ok = /^\d{6}$/.test(digits) ? await credentials.checkTotp(pending.userId, digits) : await credentials.useRecoveryCode(pending.userId, input.code);
        if (!ok) {
          limiter.fail(keys);
          await deps.activity.record(pending.userId, false, "otp", clientIp(c), c.req.header("user-agent") ?? "");
          throw new SignInError(401, "errors.signIn.wrongCode");
        }
        // Only one request gets past the second factor.
        if (!(await credentials.takeChallenge(key))) throw new SignInError(400, "errors.signIn.expired");
        return c.json({ redirectTo: await finish(c, pending.userId, [...pending.amr, /^\d{6}$/.test(digits) ? "otp" : "kba"]) });
      })

      .post("/interaction/:uid/passkey/options", async (c) => {
        const details = await interaction(c);
        return c.json(await passkeys.authenticationOptions(details.uid));
      })
      .post("/interaction/:uid/passkey", async (c) => {
        const details = await interaction(c);
        const { response } = await body(c, z.object({ response: passkeyResponse }));
        const keys = [`ip:${clientIp(c)}`];
        if (limiter.blocked(keys)) throw new SignInError(429, "errors.signIn.tooManyAttempts");
        const userId = await passkeys.authenticate(details.uid, response as never);
        const user = userId && (await activeUser(userId));
        if (!user) {
          limiter.fail(keys);
          throw new SignInError(401, "errors.signIn.unknownPasskey");
        }
        // A passkey with user verification is two factors on its own.
        return c.json({ redirectTo: await finish(c, user.id, ["hwk", "user"]) });
      })

      // Sends a sign-in link; the answer is the same whether the address is known or not.
      .post("/interaction/:uid/email-link", async (c) => {
        const details = await interaction(c);
        if (!deps.mailer) throw new SignInError(404, "errors.signIn.mailOff");
        const input = await body(c, z.object({ email }));
        const keys = [`mail-ip:${clientIp(c)}`, `mail:${input.email.toLowerCase()}`];
        if (limiter.blocked(keys)) throw new SignInError(429, "errors.signIn.tooManyAttempts");
        limiter.fail(keys);
        const user = await users.findByEmail(input.email);
        if (user && !user.disabled && user.email) {
          // The link brings the browser back to this same authorization, so it ends in the app that asked.
          const again = `${deps.issuer}/authorize?${new URLSearchParams(Object.entries(details.params).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])))}`;
          const link = await users.loginLink(user.id, EMAIL_LINK_HOURS, "email", again);
          const locale = requestLocale(c.req.header("accept-language"));
          await deps.mailer.send({
            to: user.email,
            subject: translate(locale, "email.signInLink.subject", { app: deps.appName }),
            text: translate(locale, "email.signInLink.text", { link, count: EMAIL_LINK_HOURS, app: deps.appName }),
          });
        }
        return c.json({ sent: true });
      })

      // Social sign-in: off to the provider, then back through /social/:provider/callback.
      .get("/interaction/:uid/social/:provider", async (c) => {
        const details = await interaction(c);
        const providerId = c.req.param("provider");
        if (!isProvider(providerId) || !social.enabled().includes(providerId)) throw new SignInError(404, "errors.signIn.unknownProvider");
        const state = newToken();
        const s: SocialState = { provider: providerId, nonce: newToken(), verifier: newToken(), uid: details.uid };
        await credentials.putChallenge(`social:${state}`, s, STEP_TTL_MS);
        return c.redirect(social.authorizeUrl(providerId, { state, nonce: s.nonce, verifier: s.verifier }), 302);
      })
      .get("/interaction/:uid/social-callback", async (c) => {
        const details = await interaction(c);
        const uid = details.uid;
        const fail = (message: string) => c.redirect(loginPage(uid, { error: message }), 303);
        const s = await credentials.takeChallenge<SocialState>(`social:${c.req.query("state") ?? ""}`);
        if (!s || s.uid !== uid) return fail(say(c, "errors.signIn.expiredRetry"));
        if (c.req.query("error")) return fail(say(c, "errors.signIn.providerCancelled"));
        let profile;
        try {
          profile = await social.profile(s.provider, c.req.query("code") ?? "", s);
        } catch (err) {
          if (err instanceof SocialLoginError) return fail(err.in(requestLocale(c.req.header("accept-language"))));
          throw err;
        }
        let userId = await credentials.userForIdentity(s.provider, profile.subject);
        if (!userId && profile.emailVerified && profile.email) {
          // The provider vouches for the address: an invited user can sign in this way at once.
          const byEmail = await users.findByEmail(profile.email);
          if (byEmail && !byEmail.disabled) {
            await credentials.linkIdentity(byEmail.id, s.provider, profile.subject, profile.email);
            await users.markEmailVerified(byEmail.id);
            userId = byEmail.id;
          }
        }
        const user = userId && (await activeUser(userId));
        if (!user) {
          return fail(say(c, "errors.signIn.noUser"));
        }
        const next = await firstFactorDone(c, uid, user.id, ["ext"]);
        return c.redirect("redirectTo" in next ? next.redirectTo : loginPage(uid), 303);
      })

      // The providers call back here. Sign-ins bounce on to their interaction, whose cookie lives on that path;
      // linking to a signed-in user finishes here.
      .get("/social/:provider/callback", async (c) => {
        const stateId = c.req.query("state") ?? "";
        const s = await credentials.peekChallenge<SocialState>(`social:${stateId}`);
        const query = new URL(c.req.url).search;
        if (s?.uid) return c.redirect(`/interaction/${encodeURIComponent(s.uid)}/social-callback${query}`, 303);
        const back = (params: Record<string, string>) => c.redirect(`/account?${new URLSearchParams(params)}`, 303);
        const taken = await credentials.takeChallenge<SocialState>(`social:${stateId}`);
        if (!taken?.linkUser || taken.provider !== c.req.param("provider")) return back({ error: say(c, "errors.link.expired") });
        if (c.req.query("error")) return back({ error: say(c, "errors.link.cancelled") });
        // The browser must be signed in as the user who asked to link, so nobody can slip their account into
        // someone else's (a link started by one person and finished in another's browser).
        const [req, res] = nodePair(c);
        const session = await provider.Session.get(provider.createContext(req, res) as never);
        if (session.accountId !== taken.linkUser) return back({ error: say(c, "errors.link.signedOut") });
        try {
          const profile = await social.profile(taken.provider, c.req.query("code") ?? "", taken);
          await credentials.linkIdentity(taken.linkUser, taken.provider, profile.subject, profile.email);
          if (profile.emailVerified && profile.email && profile.email === (await users.get(taken.linkUser)).email) await users.markEmailVerified(taken.linkUser);
        } catch (err) {
          if (err instanceof SocialLoginError || err instanceof CredentialError) return back({ error: err.in(requestLocale(c.req.header("accept-language"))) });
          throw err;
        }
        return back({ linked: taken.provider });
      })

      // One-time links. Opening one only remembers it in this browser and starts a sign-in; it is used up when the
      // sign-in reaches us, so mail scanners that fetch links don't burn it. `to` (set when the link was made) is where
      // that sign-in starts: an app's page or this provider's authorization; anything else goes to the account page.
      .get("/link/:token", async (c) => {
        setCookie(c, LINK_COOKIE, c.req.param("token"), {
          path: LINK_COOKIE_PATH,
          httpOnly: true,
          sameSite: "Lax",
          secure: c.req.header("x-forwarded-proto") === "https",
          maxAge: 15 * 60,
        });
        const to = c.req.query("to");
        return c.redirect(to && (await deps.clients.trustedReturn(to, deps.issuer)) ? to : "/account/signin", 302);
      })

      .get("/pictures/:userId/:version", async (c) => {
        const picture = await users.picture(c.req.param("userId"), c.req.param("version"));
        if (!picture) return c.body(null, 404);
        // Pictures are at most 2 MB; the type comes from the bytes (only PNG and JPEG are accepted on upload).
        const data = await readAll(picture.body);
        return c.body(new Uint8Array(data), 200, {
          "content-type": data[0] === 0x89 ? "image/png" : "image/jpeg",
          // A new picture gets a new URL.
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
      })

      .get("/static/logout.js", (c) =>
        c.body('document.getElementById("op.logoutForm")?.requestSubmit?.(document.querySelector("button[name=logout]"));\n', 200, {
          "content-type": "text/javascript",
          "cache-control": "public, max-age=3600",
        }),
      )
      .get("/static/page.css", (c) =>
        c.body(
          "body{font-family:system-ui,sans-serif;background:#f7f6f2;color:#1f1d1a;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}a,button{color:#7a4b12}button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:none;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#ecebe7}a,button{color:#f0b46a}}\n",
          200,
          { "content-type": "text/css", "cache-control": "public, max-age=3600" },
        ),
      )
  );
}

/** The signed-in user's sign-in methods (`/api/me/security`, for the account page; the browser's session cookie says who). */
export function securityRoutes(deps: AuthDeps, me: (c: Context) => string, sessionUid: (c: Context) => string | undefined = () => undefined) {
  const { users, credentials, passkeys, social } = deps;
  const iso = (ms: number) => new Date(ms).toISOString();

  const overview = async (userId: string): Promise<SecurityOverview> => {
    const s = await credentials.summary(userId);
    return {
      password: s.password,
      totp: s.totp,
      recoveryCodes: s.recoveryCodes,
      passkeys: s.passkeys.map((p) => ({ id: p.id, name: p.name, createdAt: iso(p.createdAt), lastUsedAt: p.lastUsedAt === null ? null : iso(p.lastUsedAt) })),
      social: s.identities.filter((i) => isProvider(i.provider)).map((i) => ({ provider: i.provider as SocialProvider, email: i.email, linkedAt: iso(i.createdAt) })),
      providers: social.enabled(),
    };
  };

  /** Turning off the second factor or replacing its codes takes a current code. */
  const requireSecondFactor = async (userId: string, value: string) => {
    const digits = value.replace(/\s/g, "");
    const ok = /^\d{6}$/.test(digits) ? await credentials.checkTotp(userId, digits) : await credentials.useRecoveryCode(userId, value);
    if (!ok) throw new HttpError(400, "errors.signIn.wrongCode");
  };

  return new Hono()
    .get("/", async (c) => c.json(await overview(me(c))))
    .get("/activity", async (c) => c.json({ events: await deps.activity.history(me(c)), sessions: await deps.activity.sessions(me(c), sessionUid(c)) }))
    .delete("/sessions/:id", async (c) => {
      const id = parse(z.string().min(1).max(200), c.req.param("id"));
      if (!(await deps.activity.revoke(me(c), id))) throw new HttpError(404, "errors.session.notFound");
      return c.body(null, 204);
    })

    .put("/password", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ current: z.string().max(PASSWORD_MAX).optional(), password: z.string() }));
      const problem = passwordProblem(input.password);
      if (problem) throw new HttpError(400, problem.key, problem.params);
      if ((await credentials.hasPassword(userId)) && !(await credentials.verifyOwnPassword(userId, input.current ?? ""))) {
        throw new HttpError(400, "errors.password.currentWrong");
      }
      await credentials.setPassword(userId, input.password);
      return c.json(await overview(userId));
    })
    .delete("/password", async (c) => {
      const userId = me(c);
      await credentials.assertAnotherMethod(userId, "password");
      await credentials.setPassword(userId, null);
      return c.json(await overview(userId));
    })

    .post("/passkeys/options", async (c) => c.json(await passkeys.registrationOptions(await users.get(me(c)))))
    .post("/passkeys", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ response: passkeyResponse, name: z.string().trim().min(1).max(60) }));
      await passkeys.register(userId, input.response as never, input.name);
      return c.json(await overview(userId), 201);
    })
    .patch("/passkeys/:id", async (c) => {
      const userId = me(c);
      const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
      await credentials.renamePasskey(userId, c.req.param("id"), name);
      return c.json(await overview(userId));
    })
    .delete("/passkeys/:id", async (c) => {
      const userId = me(c);
      await credentials.assertAnotherMethod(userId, "passkey");
      await credentials.removePasskey(userId, c.req.param("id"));
      return c.json(await overview(userId));
    })

    .post("/totp", async (c) => {
      const user = await users.get(me(c));
      if (await credentials.hasTotp(user.id)) throw new HttpError(409, "errors.totp.alreadyOn");
      return c.json(await credentials.startTotp(user.id, user.email ?? user.name ?? user.id));
    })
    .post("/totp/confirm", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ code }));
      const recoveryCodes = await credentials.confirmTotp(userId, input.code);
      if (!recoveryCodes) throw new HttpError(400, "errors.totp.wrongCode");
      return c.json({ recoveryCodes, security: await overview(userId) });
    })
    .delete("/totp", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ code }));
      await requireSecondFactor(userId, input.code);
      await credentials.disableTotp(userId);
      return c.json(await overview(userId));
    })
    .post("/recovery-codes", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ code }));
      if (!(await credentials.hasTotp(userId))) throw new HttpError(400, "errors.totp.off");
      await requireSecondFactor(userId, input.code);
      return c.json({ recoveryCodes: await credentials.newRecoveryCodes(userId), security: await overview(userId) });
    })

    // Linking a social account: the browser goes to the provider and comes back to /social/:provider/callback.
    .post("/social/:provider", async (c) => {
      const providerId = c.req.param("provider");
      if (!isProvider(providerId) || !social.enabled().includes(providerId)) throw new HttpError(404, "errors.signIn.unknownProvider");
      const state = newToken();
      const s: SocialState = { provider: providerId, nonce: newToken(), verifier: newToken(), linkUser: me(c) };
      await credentials.putChallenge(`social:${state}`, s, STEP_TTL_MS);
      return c.json({ url: social.authorizeUrl(providerId, { state, nonce: s.nonce, verifier: s.verifier }) });
    })
    .delete("/social/:provider", async (c) => {
      const userId = me(c);
      await credentials.assertAnotherMethod(userId, "identity");
      await credentials.unlinkIdentity(userId, c.req.param("provider"));
      return c.json(await overview(userId));
    });
}
