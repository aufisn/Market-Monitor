# DG-3 decision record (PRD 9.6)

- **Decision date:** 24 Nov 2026
- **Chosen alternative:** **A, "Glance Line"**, as specified in `ux/alternatives.md`, section "Alternative A", and in the A views of `ux/index.html`.
- **Decided by:** the owner, in the build chat.

## Changes folded in (both already allowed by the PRD)
1. **Details shows the full card.** The Details button on an alert shows every FR-5.5 field, grouped Price / Levels / Volume / Time. It is sent as a separate silent reply, so the short alert above it stays unchanged.
2. **Combined reminders (FR-4.13).** Reminders due in the same minute for one stock go out as one message, with an Acknowledge button for each rule plus "Ack all".

## Assumptions carried forward (can be changed later without reopening DG-3)
- "Ack + move +1%" moves the crossed threshold by 1% of its own value: HIGH goes up, LOW goes down.
- VOLUME alerts get no "Ack + move" button in v1.

Under PRD 9.6, the developer may not change this record without new approval.
