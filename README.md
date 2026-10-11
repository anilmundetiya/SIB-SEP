# SIB-SEP — Sibling Setup for Brand-viewer

Chrome extension that automates the sibling group creation flow on Dropy Brand Viewer (`http://localhost:8899`).

## Install (one-time)

1. Extract the `sib-sep` folder somewhere permanent (do not keep it in Downloads — Chrome disables extensions loaded from ephemeral folders).
2. Open Chrome → `chrome://extensions`
3. Toggle **Developer mode** ON (top-right)
4. Click **Load unpacked** → select the `sib-sep` folder
5. Pin the SIB-SEP icon in the toolbar for easy access

## Use

1. Open Brand Viewer: `http://localhost:8899/` (keep this tab open during automation)
2. Click the SIB-SEP icon
3. Drop your CSV / XLSX files onto the drop zone (or click to browse)
    - Columns required: `GroupID`, `ASIN`, `Label`
    - Multiple files allowed — processed in the order added
4. Click **Start**
5. Watch the progress in real time. Popup can be closed — automation continues in the background.

## Delays

| ASINs per group | Step 3 wait (after Search) | Step 6 wait (after Save) |
|:---:|:---:|:---:|
| 1 – 5   | 7 s  | 15 s |
| 6 – 10  | 10 s | 22 s |
| 11 – 20 | 20 s | 44 s |
| 21 – 30 | 30 s | 66 s |

If the results / save don't complete in the expected time, the extension auto-extends by 5 s per retry, up to 5 retries. After that, the group is added to **Failed groups** and the run moves on.

## Failure history

Failed groups are persisted. Use the panel at the bottom to:
- **Retry all** — re-queues failed groups as a new file (labels are lost; re-upload the original if labels matter)
- **Copy CSV** — copies the failure list to clipboard as CSV
- **Clear** — wipes the history

## Resume

If the automation is interrupted (Chrome closed, PC restart, popup close during long run), the next time the popup opens it will offer to **Resume** from the last completed group.

## After code changes

Reload the extension: `chrome://extensions` → click the ↻ refresh icon on the SIB-SEP card.
