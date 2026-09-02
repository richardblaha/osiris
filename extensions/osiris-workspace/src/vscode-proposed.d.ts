/**
 * The slice of VS Code's proposed `resolvers` API this extension uses. Declared
 * here so the extension type-checks against stable `@types/vscode`; at runtime
 * we feature-detect before calling it.
 */
import type * as vscode from 'vscode';

declare module 'vscode' {
  export class ResolvedAuthority {
    constructor(host: string, port: number, connectionToken?: string);
    readonly host: string;
    readonly port: number;
    readonly connectionToken: string | undefined;
  }

  export interface RemoteAuthorityResolver {
    resolve(
      authority: string,
    ): vscode.ResolvedAuthority | Thenable<vscode.ResolvedAuthority>;
  }

  export namespace workspace {
    export function registerRemoteAuthorityResolver(
      authorityPrefix: string,
      resolver: vscode.RemoteAuthorityResolver,
    ): vscode.Disposable;
  }
}
