/**
 * PLACEHOLDER renderer: plain debug text so the pipeline can be tested end to
 * end. NOT the production layout: that waits for the DG-3 decision.
 */
import type { OutboundEvent, RuleState } from "../core/ports";
import { encodeAck, encodeAckAll, encodeMute } from "./callbacks";
import { escapeHtml, type Button, type Rendered } from "./telegram";

const TAG = "[draft layout]";
const e = escapeHtml;
const num = (n: number | undefined): string => (typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "-");

function ackRow(rules: RuleState[]): Button[][] {
  return rules.map((r) => [{ text: `Acknowledge ${r.symbol} ${r.rule}`, data: encodeAck(r.symbol, r.rule, r.cycle) }]);
}

export function renderPlaceholder(ev: OutboundEvent): Rendered {
  switch (ev.type) {
    case "FIRST_ALERT":
      return {
        text: `${TAG}\nFIRST ALERT ${e(ev.rule.symbol)} ${ev.rule.rule}\nthreshold ${num(ev.threshold)} last ${num(ev.market.last?.p)}\nprev close ${num(ev.market.prev?.close)} open ${num(ev.market.open)}\ncycle ${ev.rule.cycle}`,
        buttons: [...ackRow([ev.rule]), [{ text: "Mute 1h", data: encodeMute(ev.rule.symbol, 60) }]],
      };
    case "LATE_ALERT":
      return {
        text: `${TAG}\nLATE ALERT ${e(ev.rule.symbol)} ${ev.rule.rule}\nthreshold ${num(ev.threshold)} bar price ${num(ev.barPrice)}\nbar time ${new Date(ev.barTimeMs).toISOString()}\ncycle ${ev.rule.cycle}`,
        buttons: ackRow([ev.rule]),
      };
    case "REMINDER":
      return {
        text: `${TAG}\nREMINDER ${e(ev.market.symbol)} (${ev.rules.map((r) => `${r.rule} #${r.remindersSent}`).join(", ")})\nlast ${num(ev.market.last?.p)} back inside: ${ev.backInside ? "yes" : "no"}`,
        buttons: ackRow(ev.rules),
      };
    case "ACK_CONFIRM":
      return { text: `${TAG}\nAcknowledged ${e(ev.rule.symbol)} ${ev.rule.rule} cycle ${ev.rule.cycle}` };
    case "BRIEFING":
      return { text: `${TAG}\nBRIEFING ${e(ev.date)}\n${ev.stocks.map((s) => `${e(s.symbol)} prev ${num(s.prev?.close)} open ${num(s.open)}`).join("\n")}`, silent: true };
    case "UNACK_AT_CLOSE":
      return { text: `${TAG}\nUNACKNOWLEDGED AT CLOSE ${e(ev.date)}\n${ev.rules.map((r) => `${e(r.symbol)} ${r.rule}`).join("\n")}`, buttons: [[{ text: "Acknowledge all", data: encodeAckAll() }]] };
    case "READY":
      return { text: `${TAG}\nREADY ${e(ev.date)}\n${e(JSON.stringify(ev.info))}`, silent: true };
    case "SESSION_ENDED":
      return { text: `${TAG}\nSESSION ENDED ${e(ev.date)}\n${e(JSON.stringify(ev.counts))}`, silent: true };
    case "OPS_NOTICE":
      return { text: `${TAG}\nOPS NOTICE ${e(ev.code)}\n${e(ev.detail)}` };
    case "TEST_ALERT":
      return { text: `${TAG}\nTEST ALERT (not a real alert)`, buttons: [[{ text: "Acknowledge (test)", data: encodeAck("TEST", "HIGH", 0) }]] };
  }
}

/** Plain reply text for commands (also placeholder). */
export function renderReply(text: string): Rendered {
  return { text: `${TAG}\n${e(text)}` };
}
