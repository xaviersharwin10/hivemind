import { useEffect, useMemo, useState } from "react";
import {
  useWallets,
  useConnectWallet,
  useCurrentAccount,
  useSignTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import {
  generateDelegateKey,
  onboardGroupSponsored,
  registerGroupSponsored,
  addDelegateKeySponsored,
  hexToBytes,
  type SuiClient,
} from "@hivemind/core/browser";
import { config } from "./config";

type Mode = "onboard" | "connect";
type Phase = "idle" | "working" | "done" | "error";
type StepState = "pending" | "active" | "done";
interface Step { id: string; label: string; state: StepState; }

/** Read the link params (hash first, then query, then sessionStorage for redirect-safety). */
function readParams(): { mode: Mode; chatId: string; token: string; connectToken: string } {
  const p = new URLSearchParams(
    window.location.hash.replace(/^#/, "") || window.location.search.replace(/^\?/, ""),
  );
  const connect = p.get("connect");
  const chat = p.get("chat");
  if (connect) {
    sessionStorage.setItem("hm_mode", "connect");
    sessionStorage.setItem("hm_connect", connect);
  } else if (chat) {
    sessionStorage.setItem("hm_mode", "onboard");
    sessionStorage.setItem("hm_chat", chat);
    sessionStorage.setItem("hm_token", p.get("t") ?? "");
  }
  const mode = (sessionStorage.getItem("hm_mode") as Mode) ?? "onboard";
  return {
    mode,
    chatId: chat ?? sessionStorage.getItem("hm_chat") ?? "",
    token: p.get("t") ?? sessionStorage.getItem("hm_token") ?? "",
    connectToken: connect ?? sessionStorage.getItem("hm_connect") ?? "",
  };
}

interface ConnectInfo {
  accountId: string;
  memberPublicKey: string;
  label: string;
  requesterName: string;
}

const ONBOARD_STEPS: Step[] = [
  { id: "auth", label: "Verifying your Google identity", state: "pending" },
  { id: "vault", label: "Creating your encrypted group vault", state: "pending" },
  { id: "chain", label: "Registering your group on-chain", state: "pending" },
  { id: "activate", label: "Activating the HiveMind bot", state: "pending" },
];
const CONNECT_STEPS: Step[] = [
  { id: "auth", label: "Verifying you're the group owner", state: "pending" },
  { id: "grant", label: "Granting access on-chain", state: "pending" },
  { id: "notify", label: "Delivering the member's key", state: "pending" },
];

export function App() {
  const { mode, chatId, token, connectToken } = useMemo(readParams, []);
  const wallets = useWallets();
  const { mutateAsync: connect } = useConnectWallet();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const account = useCurrentAccount();
  const suiClient = useSuiClient();

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [connectInfo, setConnectInfo] = useState<ConnectInfo | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [copied, setCopied] = useState(false);

  const googleWallet = useMemo(
    () => wallets.filter(isEnokiWallet).find((w) => w.provider === "google"),
    [wallets],
  );

  // In connect mode, fetch what we're approving.
  useEffect(() => {
    if (mode !== "connect" || !connectToken) return;
    fetch(`${config.botApiUrl}/connect/info?token=${encodeURIComponent(connectToken)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Connect request not found or expired."))))
      .then(setConnectInfo)
      .catch((e) => setError(e.message));
  }, [mode, connectToken]);

  function startSteps(s: Step[]) { setSteps(s.map((x) => ({ ...x }))); }
  function mark(id: string, state: StepState) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, state } : s)));
  }

  async function signIn(): Promise<string> {
    let owner = account?.address;
    if (!owner) {
      if (!googleWallet) throw new Error("Google sign-in unavailable (check Enoki/Google config).");
      const res = await connect({ wallet: googleWallet });
      owner = res.accounts[0]?.address;
    }
    if (!owner) throw new Error("No account after sign-in.");
    return owner;
  }

  function sponsorCtx(owner: string) {
    return {
      suiClient: suiClient as unknown as SuiClient,
      relayerUrl: config.botApiUrl, // bot backend sponsors via Enoki
      sender: owner,
      signTransaction: ({ transaction }: { transaction: Parameters<typeof signTransaction>[0]["transaction"] }) =>
        signTransaction({ transaction, chain: `sui:${config.network}` }),
    };
  }

  async function runOnboard() {
    setError("");
    setPhase("working");
    startSteps(ONBOARD_STEPS);
    try {
      mark("auth", "active");
      const owner = await signIn();
      mark("auth", "done");

      const botDelegate = await generateDelegateKey();
      const ctx = sponsorCtx(owner);

      mark("vault", "active");
      const out = await onboardGroupSponsored({ ctx, network: config.network, botDelegate });
      mark("vault", "done");

      mark("chain", "active");
      const reg = await registerGroupSponsored({
        ctx,
        network: config.network,
        chatId,
        memwalAccount: out.accountId,
        namespace: chatId, // per-group namespace → one creator's groups don't share memory
        writer: out.botDelegate.suiAddress,
      });
      mark("chain", "done");

      mark("activate", "active");
      const save = await fetch(`${config.botApiUrl}/onboard/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          token,
          ownerAddress: out.ownerAddress,
          accountId: out.accountId,
          botDelegateKey: out.botDelegate.privateKey,
          onchainGroupId: reg.groupId,
        }),
      });
      if (!save.ok) throw new Error(`Backend rejected: ${save.status} ${await save.text()}`);
      mark("activate", "done");

      setResult(out.accountId);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  async function runApprove() {
    if (!connectInfo) return;
    setError("");
    setPhase("working");
    startSteps(CONNECT_STEPS);
    try {
      mark("auth", "active");
      const owner = await signIn();
      mark("auth", "done");

      mark("grant", "active");
      await addDelegateKeySponsored({
        ctx: sponsorCtx(owner),
        network: config.network,
        accountId: connectInfo.accountId,
        publicKey: hexToBytes(connectInfo.memberPublicKey),
        label: connectInfo.label,
      });
      mark("grant", "done");

      mark("notify", "active");
      const done = await fetch(`${config.botApiUrl}/connect/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: connectToken }),
      });
      if (!done.ok) throw new Error(`Backend rejected: ${done.status} ${await done.text()}`);
      mark("notify", "done");

      setResult(connectInfo.accountId);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  const busy = phase === "working";
  const isOnboard = mode === "onboard";

  return (
    <div className="wrap">
      <div className="brand">
        <span className="mark">🐝</span>
        <span className="name">HiveMind</span>
        <span className="net">{config.network}</span>
      </div>

      <div className="card">
        {busy ? (
          <Progress
            title={isOnboard ? "Building your group's memory…" : "Approving access…"}
            steps={steps}
          />
        ) : phase === "done" ? (
          isOnboard ? (
            <Success
              title="Your group brain is live."
              account={result!}
              copied={copied}
              onCopy={() => { navigator.clipboard?.writeText(result!); setCopied(true); }}
              note="Head back to Telegram — HiveMind is now capturing your group's decisions and files, all under an account only you control."
            />
          ) : (
            <Success
              title="Member approved."
              account={result!}
              copied={copied}
              onCopy={() => { navigator.clipboard?.writeText(result!); setCopied(true); }}
              note="They've been DMed their personal key and a ready-to-paste AI config by the bot."
            />
          )
        ) : isOnboard ? (
          <>
            <p className="eyebrow">Group memory · self-custodied</p>
            <h1>Create your group's on-chain memory vault.</h1>
            <p className="lead">
              HiveMind turns your group chat's decisions and files into a <b>verifiable, portable AI
              memory</b> on Sui &amp; Walrus — that <b>you own</b>. Any AI tool can later recall it.
            </p>
            {!chatId && <div className="alert">Missing group link. Open the link the HiveMind bot sent you.</div>}
            <button onClick={runOnboard} disabled={busy || !chatId} className="btn">
              <span className="g">G</span>
              {account ? "Create my group memory" : "Continue with Google"}
            </button>
            <div className="chips">
              <span className="chip">🔑 You hold the keys</span>
              <span className="chip">⚡ Gas sponsored</span>
              <span className="chip">🔒 Seal-encrypted</span>
            </div>
          </>
        ) : (
          <>
            <p className="eyebrow">Owner approval</p>
            <h1>Connect {connectInfo?.requesterName ?? "a member"}'s AI to this group.</h1>
            <p className="lead">
              Only the group <b>owner</b> can grant access. Sign in with the Google account you onboarded
              with to add <b>{connectInfo?.requesterName ?? "this member"}</b>'s delegate key on-chain.
            </p>
            {error && !connectInfo && <div className="alert">{error}</div>}
            <button onClick={runApprove} disabled={busy || !connectInfo} className="btn">
              <span className="g">G</span>
              {connectInfo ? "Sign in with Google & approve" : "Loading request…"}
            </button>
            <div className="chips">
              <span className="chip">🛡️ Owner-only</span>
              <span className="chip">⚡ Gas sponsored</span>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="alert">⚠️ {error}</div>
            <p className="note">
              <button className="linkbtn" onClick={() => setPhase("idle")}>Try again</button>
            </p>
          </>
        )}
      </div>

      <p className="foot">
        Powered by <b>Sui zkLogin</b> · <b>Walrus</b> · <b>Seal</b> · <b>Enoki</b>
      </p>
    </div>
  );
}

function Progress({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <div>
      <p className="eyebrow">Working</p>
      <h1 style={{ fontSize: 22 }}>{title}</h1>
      <ul className="steps">
        {steps.map((s) => (
          <li key={s.id} className={`step ${s.state}`}>
            <span className="dot">{s.state === "done" ? "✓" : s.state === "active" ? "" : ""}</span>
            {s.label}
          </li>
        ))}
      </ul>
      <p className="note">This takes a few seconds — each step is a real on-chain action, gas sponsored.</p>
    </div>
  );
}

function Success({
  title, account, note, copied, onCopy,
}: { title: string; account: string; note: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="center">
      <div className="seal">✓</div>
      <h1 style={{ fontSize: 22 }}>{title}</h1>
      <p className="note">{note}</p>
      <div className="idchip">
        <span>{account.slice(0, 10)}…{account.slice(-6)}</span>
        <a href={`https://suiscan.xyz/${config.network}/object/${account}`} target="_blank" rel="noreferrer">view ↗</a>
        <button onClick={onCopy}>{copied ? "copied" : "copy"}</button>
      </div>
    </div>
  );
}
