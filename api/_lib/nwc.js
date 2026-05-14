/**
 * Inline NIP-47 (NWC) pay_invoice client with per-step diagnostic trace.
 *
 * Replaces l402-requests' NwcWallet because that implementation:
 *   - silently drops relay "OK" confirmations (the relay's only way to
 *     tell us our event was rejected — invalid sig, rate-limited, etc.)
 *   - subscribes by "#p" only (broader than necessary); we use "#e"
 *     here to match exactly the wallet reply to our request event
 *   - depends on @noble/secp256k1 v1.7.x (v2+ dropped schnorr); using
 *     @noble/curves directly avoids that compatibility cliff and
 *     matches the modern import path
 *
 * Every payment attempt builds a `trace[]` of timestamped events and
 * relay messages, returned alongside the preimage on success or the
 * error on failure. This lets a deploy-time bug be diagnosed by looking
 * at the response body — no Vercel runtime log access needed.
 */

import { schnorr } from "@noble/curves/secp256k1";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import WebSocket from "ws";

const NWC_REQUEST_KIND = 23194;
const NWC_RESPONSE_KIND = 23195;

/**
 * Pay a BOLT11 invoice using a NIP-47 (NWC) wallet.
 *
 * @param {string} nwcUrl  nostr+walletconnect://<walletPubkey>?relay=<wss>&secret=<hex>
 * @param {string} bolt11  invoice to pay
 * @param {{ timeoutMs?: number }} opts
 * @returns {Promise<{ preimage: string, trace: object[] }>}
 *   On success, resolves with the preimage and a step-by-step trace.
 *   On failure, throws an Error with `.trace` attached (array of step
 *   objects with `t` = ms since start, `step` = label, plus extras).
 */
export async function payViaNwc(nwcUrl, bolt11, { timeoutMs = 25_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  const t = () => Date.now() - startedAt;
  const record = (step, extras = {}) => trace.push({ t: t(), step, ...extras });

  // ── 1. Parse NWC URL ────────────────────────────────────────────────
  let url, walletPubkey, relay, secret;
  try {
    url = new URL(nwcUrl);
    walletPubkey = (url.hostname || url.pathname.replace(/^\/\//, "")).toLowerCase();
    relay = url.searchParams.get("relay") ?? "";
    secret = (url.searchParams.get("secret") ?? "").toLowerCase();
  } catch (e) {
    throwWithTrace(`NWC URL malformed: ${e.message}`, trace);
  }
  if (!walletPubkey || !/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throwWithTrace("NWC URL missing or malformed wallet pubkey (expected 64 hex chars).", trace);
  }
  if (!relay) throwWithTrace("NWC URL missing relay query param.", trace);
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) {
    throwWithTrace("NWC URL missing or malformed secret (expected 64 hex chars).", trace);
  }
  record("nwc_url_parsed", { relay: hostOf(relay) });

  // ── 2. Derive client identity from NWC secret ───────────────────────
  const secretBytes = hexToBytes(secret);
  // schnorr.getPublicKey returns the x-only (32-byte) pubkey directly.
  const myPubkey = bytesToHex(schnorr.getPublicKey(secretBytes));
  record("identity_derived", { myPubkey: myPubkey.slice(0, 16) + "…" });

  // ── 3. Compute shared secret X for NIP-04 encryption ────────────────
  // ECDH on secp256k1: getSharedSecret returns 33-byte compressed point.
  // The shared X is bytes 1..33 (drop the 02/03 prefix).
  const sharedPoint = secp256k1.getSharedSecret(secretBytes, "02" + walletPubkey);
  const sharedX = sharedPoint.slice(1, 33);

  // ── 4. Build the NIP-04 encrypted NIP-47 pay_invoice payload ────────
  const requestPayload = JSON.stringify({
    method: "pay_invoice",
    params: { invoice: bolt11 },
  });
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    sharedX,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt"],
  );
  const ctBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      new TextEncoder().encode(requestPayload),
    ),
  );
  const content = `${b64(ctBytes)}?iv=${b64(iv)}`;
  record("payload_encrypted_nip04");

  // ── 5. Build, hash, sign the Nostr event (kind 23194) ───────────────
  const createdAt = Math.floor(Date.now() / 1000);
  const eventCore = {
    kind: NWC_REQUEST_KIND,
    pubkey: myPubkey,
    created_at: createdAt,
    tags: [["p", walletPubkey]],
    content,
  };
  // NIP-01 event-id serialization is fixed-order, whitespace-free JSON.
  const serialized = JSON.stringify([
    0,
    eventCore.pubkey,
    eventCore.created_at,
    eventCore.kind,
    eventCore.tags,
    eventCore.content,
  ]);
  const eventId = bytesToHex(sha256(new TextEncoder().encode(serialized)));
  const sig = bytesToHex(schnorr.sign(hexToBytes(eventId), secretBytes));
  const event = { ...eventCore, id: eventId, sig };
  record("event_signed", { eventId: eventId.slice(0, 16) + "…" });

  // ── 6. Open WS, send REQ + EVENT, wait for matching reply ──────────
  return await new Promise((resolve, reject) => {
    const subId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
    let ws;
    try {
      ws = new WebSocket(relay);
    } catch (e) {
      record("ws_construct_failed", { message: e.message });
      reject(errWithTrace(`Could not open WebSocket to ${hostOf(relay)}: ${e.message}`, trace));
      return;
    }
    record("ws_constructed");

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(errWithTrace(
        `NWC payment timed out after ${timeoutMs}ms. ` +
        `Last step before timeout: ${trace[trace.length - 1]?.step ?? "(none)"}. ` +
        `See trace for full diagnostic.`,
        trace,
      ));
    }, timeoutMs);

    ws.on("open", () => {
      record("ws_open");
      // Subscribe FIRST so the relay registers our subscription before
      // it broadcasts the EVENT (race-safe on every modern relay). Use
      // both "#e" (specific to our event) and "#p" (responses tagged
      // to us) so the relay matches only the wallet's direct reply.
      const reqMsg = JSON.stringify([
        "REQ", subId,
        {
          kinds: [NWC_RESPONSE_KIND],
          "#e": [eventId],
          "#p": [myPubkey],
          since: createdAt - 10,
        },
      ]);
      ws.send(reqMsg);
      record("req_sent");
      ws.send(JSON.stringify(["EVENT", event]));
      record("event_published");
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        record("message_parse_error");
        return;
      }
      if (!Array.isArray(msg) || msg.length === 0) {
        record("message_unknown_shape");
        return;
      }
      const [type, ...rest] = msg;

      // ── Relay's publish-receipt: ["OK", eventId, accepted, reason]
      // l402-requests silently drops these; we record them so a relay
      // rejection (sig invalid, rate-limit, etc.) is visible.
      if (type === "OK") {
        const [okEventId, accepted, reason] = rest;
        record("ok_received", { matchesOurEvent: okEventId === eventId, accepted, reason });
        if (okEventId === eventId && accepted === false) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(errWithTrace(
            `Relay rejected our pay_invoice event: ${reason || "(no reason given)"}`,
            trace,
          ));
        }
        return;
      }

      if (type === "EOSE") {
        record("eose_received", { matchesOurSub: rest[0] === subId });
        return;
      }

      if (type === "NOTICE") {
        record("notice_received", { message: String(rest[0] ?? "").slice(0, 200) });
        return;
      }

      if (type === "EVENT") {
        const [evSubId, ev] = rest;
        if (evSubId !== subId) {
          record("event_unrelated_sub", { kind: ev?.kind });
          return;
        }
        if (ev?.kind !== NWC_RESPONSE_KIND) {
          record("event_wrong_kind", { kind: ev?.kind });
          return;
        }
        record("event_match_received");

        // Decrypt the response content with the same sharedX.
        try {
          const [ctB64, ivB64Pair] = String(ev.content).split("?iv=");
          const respCt = u8FromB64(ctB64);
          const respIv = u8FromB64(ivB64Pair);
          const decryptKey = await crypto.subtle.importKey(
            "raw", sharedX,
            { name: "AES-CBC", length: 256 },
            false, ["decrypt"],
          );
          const plain = new TextDecoder().decode(
            await crypto.subtle.decrypt(
              { name: "AES-CBC", iv: respIv },
              decryptKey,
              respCt,
            ),
          );
          const result = JSON.parse(plain);
          record("response_decrypted", { hasError: !!result.error, hasPreimage: !!result?.result?.preimage });

          clearTimeout(timer);
          try { ws.close(); } catch {}

          if (result.error) {
            reject(errWithTrace(
              `Wallet returned NWC error ${result.error.code ?? "unknown"}: ${result.error.message ?? ""}`,
              trace,
            ));
            return;
          }
          const preimage = result?.result?.preimage;
          if (!preimage) {
            reject(errWithTrace("Wallet replied with no error but no preimage either.", trace));
            return;
          }
          resolve({ preimage, trace });
        } catch (e) {
          record("decrypt_failed", { message: e.message });
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(errWithTrace(`Failed to decrypt wallet response: ${e.message}`, trace));
        }
        return;
      }

      record("message_other_type", { type });
    });

    ws.on("error", (err) => {
      record("ws_error", { message: err?.message || String(err) });
      clearTimeout(timer);
      reject(errWithTrace(`WebSocket error on ${hostOf(relay)}: ${err?.message || err}`, trace));
    });

    ws.on("close", (code, reason) => {
      record("ws_close", { code, reason: reason?.toString?.()?.slice(0, 200) });
    });
  });
}

// ── helpers ───────────────────────────────────────────────────────────

function b64(u8) {
  return Buffer.from(u8).toString("base64");
}
function u8FromB64(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}
function hostOf(url) {
  try { return new URL(url).host; } catch { return "(unparseable)"; }
}
function errWithTrace(message, trace) {
  const e = new Error(message);
  e.trace = trace;
  return e;
}
function throwWithTrace(message, trace) {
  throw errWithTrace(message, trace);
}
