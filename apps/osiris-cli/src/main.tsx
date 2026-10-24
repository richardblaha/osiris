import { render } from "ink";
import { connect } from "@osiris/client/api.ts";
import { App } from "./App.tsx";
import { connectLocal, connectServer, login, logout, projectRoot } from "./connect.ts";
import { pickTheme } from "./theme.ts";

const HELP = `osiris-cli [folder]            Osiris over a project folder (starts its local agent when none runs)
osiris-cli --server <url>      Osiris on osiris-server (after login)
osiris-cli login <url>         signs in to osiris-server in the browser
osiris-cli logout <url>
Options: --project <id> (on a server), --theme=light|dark`;

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const server = option("server");
const project = option("project");
const positional = args.filter((a) => !a.startsWith("--"));

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
} else if (positional[0] === "login" && positional[1]) {
  await login(positional[1]);
} else if (positional[0] === "logout" && positional[1]) {
  logout(positional[1]);
} else {
  if (server) connect(connectServer(server));
  else connect((await connectLocal(projectRoot(positional[0] ?? process.cwd()), (line) => console.log(line))).connection);
  // The whole screen, like a full-screen program; the terminal is given back on exit.
  process.stdout.write("\x1b[?1049h");
  const app = render(<App theme={pickTheme()} projectId={project} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  process.stdout.write("\x1b[?1049l");
}
