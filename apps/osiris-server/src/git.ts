import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import backend from 'git-http-backend';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@osiris/shared-core';

const log = createLogger('server:git');

export interface GitHostingOptions {
  /** Directory holding the bare repositories (`<name>.git`). */
  reposDir: string;
  /** `git init --bare` a repo the first time it is pushed. Default true. */
  autoCreate?: boolean;
}

const REPO_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Normalise `foo` / `foo.git` → `foo.git`, rejecting traversal. */
export function repoDirName(raw: string): string {
  const name = raw.replace(/\.git$/i, '');
  if (!REPO_RE.test(name)) throw new Error(`invalid repository name: ${raw}`);
  return `${name}.git`;
}

/** Smart-HTTP Git hosting under `/git/<repo>.git/...` backed by the system `git`. */
export function registerGitHosting(app: FastifyInstance, options: GitHostingOptions): void {
  const autoCreate = options.autoCreate ?? true;

  // Hand the git RPC body to the handler untouched so it can be piped to `git`.
  app.addContentTypeParser(
    /^application\/x-git-(upload|receive)-pack-request$/,
    (_request, payload, done) => done(null, payload),
  );

  app.route({
    method: ['GET', 'POST'],
    url: '/git/:repo/*',
    handler: async (request, reply) => {
      const params = request.params as { repo: string; '*': string };
      let dirName: string;
      try {
        dirName = repoDirName(params.repo);
      } catch {
        return reply.code(400).send({ error: 'invalid repository name' });
      }
      const repoPath = join(options.reposDir, dirName);
      const gitUrl = `/${params['*']}${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`;
      const wantsPush = gitUrl.includes('git-receive-pack');

      if (!existsSync(repoPath)) {
        if (wantsPush && autoCreate) {
          await mkdir(repoPath, { recursive: true });
          await runGit(['init', '--bare', '--initial-branch=main', repoPath]);
          log.info('created bare repo %s', dirName);
        } else {
          return reply.code(404).send({ error: `no such repository: ${params.repo}` });
        }
      }

      reply.hijack();
      request.raw
        .pipe(
          backend(gitUrl, (error, service) => {
            if (error || !service) {
              reply.raw.statusCode = 500;
              reply.raw.end(String(error ?? 'git backend error'));
              return;
            }
            reply.raw.setHeader('content-type', service.type);
            const ps = spawn(service.cmd, [...service.args, repoPath]);
            ps.on('error', (err) => {
              reply.raw.statusCode = 500;
              reply.raw.end(String(err));
            });
            ps.stdout.pipe(service.createStream()).pipe(ps.stdin);
          }),
        )
        .pipe(reply.raw);
    },
  });

  log.info('git hosting mounted at /git/ (repos: %s)', options.reposDir);
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = spawn('git', args, { stdio: 'ignore' });
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`))));
  });
}
