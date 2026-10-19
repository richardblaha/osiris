import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecurityOverview, SignInState, SocialProvider } from "@osiris/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type Provider from "oidc-provider";
import { z } from "zod";
import { readAll } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { UserDirectory } from "../users.ts";
import { CredentialError, type Credentials } from "./credentials.ts";
import type { AttemptLimiter } from "./limiter.ts";
import type { Mailer } from "./mail.ts";
import type { Passkeys } from "./passkeys.ts";
import { newToken, passwordProblem, PASSWORD_MAX } from "./secrets.ts";
import { SOCIAL_PROVIDERS, SocialLoginError, type SocialLogin, type SocialProviderId } from "./social.ts";

export interface AuthDeps {
  db: Db;
  provider: Provider;
  users: UserDirectory;
  credentials: Credentials;
  passkeys: Passkeys;
  social: SocialLogin;
  mailer?: Mailer;
  limiter: AttemptLimiter;
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
const LINK_COOKIE_PATH = "/auth/interaction";
const EMAIL_LINK_HOURS = 1;

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
  return r.data;
};
const body = async <T>(c: Context, schema: z.ZodType<T>) =>
  parse(
    schema,
    await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "Invalid JSON" });
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
const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

/**
 * oidc-provider reads its cookies from Node's request; ours arrive through Hono. It only needs the headers, so a
 * request stand-in carries them (the response is never written: results go back as our own response).
 */
const nodePair = (c: Context) => {
  const url = new URL(c.req.url);
  const req = { headers: Object.fromEntries(c.req.raw.headers), url: url.pathname + url.search, method: c.req.method, socket: {} };
  const res = { getHeader: () => undefined, setHeader: () => {}, removeHeader: () => {}, headersSent: false };
  return [req as unknown as IncomingMessage, res as unknown as ServerResponse] as const;
};

const isProvider = (p: string): p is SocialProviderId => (SOCIAL_PROVIDERS as readonly string[]).includes(p);

export class SignInError extends HTTPException {}

/**
 * The sign-in screens' API under `/auth` (the web app's `/login` page calls it), plus the redirects of social
 * sign-in, one-time links and profile pictures. Every step is bound to the browser's interaction cookie, which
 * oidc-provider set when the sign-in started.
 */
export function authRoutes(deps: AuthDeps) {
  const { provider, users, credentials, passkeys, social, limiter } = deps;

  /** The interaction of the URL, checked against the browser's cookie. */
  const interaction = async (c: Context) => {
    const [req, res] = nodePair(c);
    const details = await provider.interactionDetails(req, res).catch(() => {
      throw new SignInError(400, { message: "Přihlášení vypršelo, začni prosím znovu" });
    });
    if (details.uid !== c.req.param("uid")) throw new SignInError(400, { message: "Přihlášení vypršelo, začni prosím znovu" });
    return details;
  };

  /** Ends the sign-in step as `userId`; where the browser goes next (back to the authorization). */
  const finish = async (c: Context, userId: string, amr: string[]) => {
    const [req, res] = nodePair(c);
    const returnTo = await provider.interactionResult(req, res, { login: { accountId: userId, amr, remember: true } }, { mergeWithLastSubmission: false });
    await deps.db.execute([run("UPDATE users SET last_login_at = ? WHERE id = ?", Date.now(), userId)]);
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
          if (!accountId) throw new SignInError(400, { message: "Přihlášení vypršelo, začni prosím znovu" });
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
          if (!link || !user) return c.redirect(loginPage(uid, { error: "Odkaz pro přihlášení je neplatný, použitý nebo vypršel." }), 303);
          if (link.purpose === "email") await users.markEmailVerified(user.id);
          const next = await firstFactorDone(c, uid, user.id, ["link"]);
          return c.redirect("redirectTo" in next ? next.redirectTo : loginPage(uid), 303);
        }
        return c.redirect(loginPage(uid), 303);
      })

      .get("/interaction/:uid/state", async (c) => {
        const details = await interaction(c);
        const pending = await credentials.peekChallenge<PendingSecondFactor>(`second-factor:${details.uid}`);
        return c.json<SignInState>({
          step: pending ? "second-factor" : "login",
          methods: { passkey: true, emailLink: !!deps.mailer, social: social.enabled() },
        });
      })

      .post("/interaction/:uid/password", async (c) => {
        const details = await interaction(c);
        const input = await body(c, z.object({ email, password }));
        const keys = [`ip:${clientIp(c)}`, `email:${input.email.toLowerCase()}`];
        if (limiter.blocked(keys)) throw new SignInError(429, { message: "Příliš mnoho pokusů, zkus to za čtvrt hodiny" });
        const userId = await credentials.checkPassword(input.email, input.password);
        if (!userId) {
          limiter.fail(keys);
          throw new SignInError(401, { message: "Nesprávný e-mail nebo heslo" });
        }
        limiter.reset([keys[1]!]);
        return c.json(await firstFactorDone(c, details.uid, userId, ["pwd"]));
      })

      .post("/interaction/:uid/second-factor", async (c) => {
        const details = await interaction(c);
        const input = await body(c, z.object({ code }));
        const key = `second-factor:${details.uid}`;
        const pending = await credentials.peekChallenge<PendingSecondFactor>(key);
        if (!pending) throw new SignInError(400, { message: "Přihlášení vypršelo, začni prosím znovu" });
        const keys = [`second-factor-user:${pending.userId}`, `ip:${clientIp(c)}`];
        if (limiter.blocked(keys)) throw new SignInError(429, { message: "Příliš mnoho pokusů, zkus to za čtvrt hodiny" });
        const digits = input.code.replace(/\s/g, "");
        const ok = /^\d{6}$/.test(digits) ? await credentials.checkTotp(pending.userId, digits) : await credentials.useRecoveryCode(pending.userId, input.code);
        if (!ok) {
          limiter.fail(keys);
          throw new SignInError(401, { message: "Kód nesouhlasí" });
        }
        // Only one request gets past the second factor.
        if (!(await credentials.takeChallenge(key))) throw new SignInError(400, { message: "Přihlášení vypršelo, začni prosím znovu" });
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
        if (limiter.blocked(keys)) throw new SignInError(429, { message: "Příliš mnoho pokusů, zkus to za čtvrt hodiny" });
        const userId = await passkeys.authenticate(details.uid, response as never);
        const user = userId && (await activeUser(userId));
        if (!user) {
          limiter.fail(keys);
          throw new SignInError(401, { message: "Tento klíč neznáme. Přihlas se jinak a přidej si ho v profilu." });
        }
        // A passkey with user verification is two factors on its own.
        return c.json({ redirectTo: await finish(c, user.id, ["hwk", "user"]) });
      })

      // Sends a sign-in link; the answer is the same whether the address is known or not.
      .post("/interaction/:uid/email-link", async (c) => {
        await interaction(c);
        if (!deps.mailer) throw new SignInError(404, { message: "Odesílání e-mailů není nastavené" });
        const input = await body(c, z.object({ email }));
        const keys = [`mail-ip:${clientIp(c)}`, `mail:${input.email.toLowerCase()}`];
        if (limiter.blocked(keys)) throw new SignInError(429, { message: "Příliš mnoho pokusů, zkus to za čtvrt hodiny" });
        limiter.fail(keys);
        const user = await users.findByEmail(input.email);
        if (user && !user.disabled && user.email) {
          const link = await users.loginLink(user.id, EMAIL_LINK_HOURS, "email");
          await deps.mailer.send({
            to: user.email,
            subject: "Přihlášení do Osirisu",
            text: `Dobrý den,\n\npro přihlášení do Osirisu otevřete tento odkaz (platí ${EMAIL_LINK_HOURS} hodinu a jen jednou):\n\n${link}\n\nPokud jste o přihlášení nežádali, e-mail ignorujte.\n`,
          });
        }
        return c.json({ sent: true });
      })

      // Social sign-in: off to the provider, then back through /auth/social/:provider/callback.
      .get("/interaction/:uid/social/:provider", async (c) => {
        const details = await interaction(c);
        const providerId = c.req.param("provider");
        if (!isProvider(providerId) || !social.enabled().includes(providerId)) throw new SignInError(404, { message: "Neznámý poskytovatel" });
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
        if (!s || s.uid !== uid) return fail("Přihlášení vypršelo, zkus to znovu.");
        if (c.req.query("error")) return fail("Přihlášení u poskytovatele bylo zrušeno.");
        let profile;
        try {
          profile = await social.profile(s.provider, c.req.query("code") ?? "", s);
        } catch (err) {
          if (err instanceof SocialLoginError) return fail(err.message);
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
          return fail("K tomuto účtu nemáme uživatele. Přihlas se jinak a propoj si ho v profilu, nebo požádej správce o pozvánku.");
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
        if (s?.uid) return c.redirect(`/auth/interaction/${encodeURIComponent(s.uid)}/social-callback${query}`, 303);
        const back = (params: Record<string, string>) => c.redirect(`/?${new URLSearchParams({ profile: "security", ...params })}`, 303);
        const taken = await credentials.takeChallenge<SocialState>(`social:${stateId}`);
        if (!taken?.linkUser || taken.provider !== c.req.param("provider")) return back({ error: "Propojení vypršelo, zkus to znovu." });
        if (c.req.query("error")) return back({ error: "Propojení bylo zrušeno." });
        // The browser must be signed in as the user who asked to link, so nobody can slip their account into
        // someone else's (a link started by one person and finished in another's browser).
        const [req, res] = nodePair(c);
        const session = await provider.Session.get(provider.createContext(req, res) as never);
        if (session.accountId !== taken.linkUser) return back({ error: "Přihlášení vypršelo. Přihlas se znovu a propojení zopakuj." });
        try {
          const profile = await social.profile(taken.provider, c.req.query("code") ?? "", taken);
          await credentials.linkIdentity(taken.linkUser, taken.provider, profile.subject, profile.email);
          if (profile.emailVerified && profile.email && profile.email === (await users.get(taken.linkUser)).email) await users.markEmailVerified(taken.linkUser);
        } catch (err) {
          if (err instanceof SocialLoginError || err instanceof CredentialError) return back({ error: err.message });
          throw err;
        }
        return back({ linked: taken.provider });
      })

      // One-time links. Opening one only remembers it in this browser and starts a sign-in; it is used up when the
      // sign-in reaches us, so mail scanners that fetch links don't burn it.
      .get("/link/:token", (c) => {
        setCookie(c, LINK_COOKIE, c.req.param("token"), {
          path: LINK_COOKIE_PATH,
          httpOnly: true,
          sameSite: "Lax",
          secure: c.req.header("x-forwarded-proto") === "https",
          maxAge: 15 * 60,
        });
        return c.redirect("/?signin=link", 302);
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

      .get("/assets/logout.js", (c) =>
        c.body('document.getElementById("op.logoutForm")?.requestSubmit?.(document.querySelector("button[name=logout]"));\n', 200, {
          "content-type": "text/javascript",
          "cache-control": "public, max-age=3600",
        }),
      )
      .get("/assets/page.css", (c) =>
        c.body(
          "body{font-family:system-ui,sans-serif;background:#f7f6f2;color:#1f1d1a;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}a,button{color:#7a4b12}button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:none;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#ecebe7}a,button{color:#f0b46a}}\n",
          200,
          { "content-type": "text/css", "cache-control": "public, max-age=3600" },
        ),
      )
  );
}

/** The signed-in user's sign-in methods (`/api/me/security`, behind the gateway). */
export function securityRoutes(deps: AuthDeps, me: (c: Context) => string) {
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
    if (!ok) throw new HTTPException(400, { message: "Kód nesouhlasí" });
  };

  return new Hono()
    .get("/", async (c) => c.json(await overview(me(c))))

    .put("/password", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ current: z.string().max(PASSWORD_MAX).optional(), password: z.string() }));
      const problem = passwordProblem(input.password);
      if (problem) throw new HTTPException(400, { message: problem });
      if ((await credentials.hasPassword(userId)) && !(await credentials.verifyOwnPassword(userId, input.current ?? ""))) {
        throw new HTTPException(400, { message: "Současné heslo nesouhlasí" });
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
      if (await credentials.hasTotp(user.id)) throw new HTTPException(409, { message: "Ověřovací aplikace už je zapnutá" });
      return c.json(await credentials.startTotp(user.id, user.email ?? user.name ?? user.id));
    })
    .post("/totp/confirm", async (c) => {
      const userId = me(c);
      const input = await body(c, z.object({ code }));
      const recoveryCodes = await credentials.confirmTotp(userId, input.code);
      if (!recoveryCodes) throw new HTTPException(400, { message: "Kód nesouhlasí. Zkontroluj čas v telefonu a zkus další kód." });
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
      if (!(await credentials.hasTotp(userId))) throw new HTTPException(400, { message: "Nejdřív si zapni ověřovací aplikaci" });
      await requireSecondFactor(userId, input.code);
      return c.json({ recoveryCodes: await credentials.newRecoveryCodes(userId), security: await overview(userId) });
    })

    // Linking a social account: the browser goes to the provider and comes back to /auth/social/:provider/callback.
    .post("/social/:provider", async (c) => {
      const providerId = c.req.param("provider");
      if (!isProvider(providerId) || !social.enabled().includes(providerId)) throw new HTTPException(404, { message: "Neznámý poskytovatel" });
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
