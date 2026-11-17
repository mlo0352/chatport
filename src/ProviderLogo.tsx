import type { Provider } from "./types";
import codex from "./assets/providers/codex.svg";
import claude from "./assets/providers/claude.ico";
import opencode from "./assets/providers/opencode.svg";
import t3 from "./assets/providers/t3.ico";
import chatgpt from "./assets/providers/chatgpt.svg";
import freebuff from "./assets/providers/freebuff.ico";
const logos: Record<Provider, string> = {
  codex,
  claude,
  opencode,
  t3,
  chatgpt,
  freebuff,
};
export const providerNames: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  t3: "T3 Code",
  chatgpt: "ChatGPT",
  freebuff: "Freebuff",
};
export default function ProviderLogo({ provider }: { provider: Provider }) {
  return (
    <span
      className={"provider-dot " + provider}
      title={providerNames[provider]}
    >
      <img src={logos[provider]} alt={providerNames[provider] + " logo"} />
    </span>
  );
}
