# CitiCore — Citi Homes operations platform

Cloud system for **Citi Homes Kitchen and Wooden Furniture Manufacturing LLC** (UAE): purchasing, stores & inventory, production,
projects & site (BOQ, installation, snags, variations), HR / payroll and accounting (general ledger, customer billing, VAT).

**Live app:** https://ch-ims-production.up.railway.app

| Layer | Where |
|---|---|
| Database, logins, business rules | Supabase project `vvkkvudwbolhuveuxorc` (Mumbai) |
| Web app (static HTML/JS, no build step) | `web/` — served by Caddy on Railway |
| Admin user function | `supabase/functions/admin-users` |

## Modules
- **Masters**: items (class, category, UoM, specs, TOC buffer, MOQ, re-order, lead time), vendors (TRN, trade licence, payment terms, bank), locations (warehouse → zone → rack → bin), projects & make-to-stock orders, employees, cost centres, payment terms, vendor price list.
- **Purchase**: requisitions → purchase orders (Factory Manager → Finance → top-management reference) → release; replenishment suggestions from TOC buffers / re-order levels.
- **Stores**: GRN against PO or non-PO / opening / customer-supplied / samples, landed cost (freight, customs, clearing), lots & batches, expiry; FIFO/FEFO issues to projects, MTS orders or cost centres; returns from floor; transfers; physical count adjustments (FM approval); purchase returns.
- **Shop floor**: material requests approved by the Production In-charge.
- **Production**: work centres master (machine / labour rates, add any number); BOM templates for standard products (cut list, hardware, route per unit); production orders for projects or MTS with cut list (Excel/CSV import, template or manual), board yield & waste % → sheets and edge-band metres; release creates the material request; job card PDF with QR; stage board where supervisors log the crew by worker grade (grade × workers × normal + overtime hours, each grade has its own normal and overtime AED/hour rate); machine downtime log (breakdowns, planned maintenance, stoppages) feeding work-centre availability and load; QC rejects go to the Factory Manager for approval (accept / rework / scrap); job costing (material + labour + machine + overhead %); finished goods go to the FG store in batches or a final receipt that absorbs all remaining cost; QC rejects become a rework order (carrying their cost) or a scrap note (cost written off); dispatch notes (full or partial) charge the project; contract value on projects and selling value on orders give margin reports.
- **Projects**: several projects run together, each with a BOQ of made in-house (→ production orders), bought-out (factory store or direct to site) and service lines (own installation team, subcontractors, hired transport); unit codes with lines attached by unit type or unit codes; billing basis per BOQ item or unit-wise (billable value exported to the accounting system); BOQ Excel import (BOQ + Units sheets); services as non-stock items through PO → work-done certificate → invoice; own-team installation logs (crew by grade incl. overtime, qty per BOQ line / unit); unit snagging / handover; BOQ and unit progress; project cost & margin; material planning (MRP) across all running projects with project-specific requisitions; BOQ baseline lock with numbered variation orders (add / change / omit, Factory Manager approval, contract value updated); Site Supervisor role (site-store receipts and handovers, delivery confirmation, installation logs, unit handover, site material requests); running-projects overview on the dashboard.
- **HR & payroll (UAE)**: HR Officer role; employee profile, documents with files and daily expiry alerts; salary & bank (visible to HR / Finance / admin only);
  daily attendance & overtime (125% / 150%); leave with UAE accrual and half-pay / unpaid sick leave; salary advances (Finance approves); monthly payroll (HR calculates,
  Finance approves / returns, marks paid), payslips PDF, WPS SIF file; gratuity & leave provision and end-of-service calculation (Decree-Law 33/2021).
- **Snags & site app**: snag list per unit with phone-camera photos (private storage), site supervisor fixes (rework crew costed), Production In-charge / FM verifies or reopens; no handover with open snags; snag register; phone-first **Site app** (units, log work, snags, deliveries to confirm) that site supervisors land on.
- **Tool crib & assets**: machines, power/hand/measuring tools, office and labour-accommodation equipment get an asset tag per unit; issue/return to workers, overdue tracking, calibration.
- **Scrap**: scrap generation and write-off (FM approval), scrap-yard stock, disposal / sale with gate pass (Factory Manager → Finance confirms rates & receipt).
- **Project vs stock purchasing**: every requisition / PO / GRN line is either for general stock or for a named project. Project lines create stock **reserved** for that project (only its issues can use it; own stock is issued first). Leftovers go back to general stock through an FM-approved **Project stock release**. Buffers and re-order suggestions use free stock and stock POs only.
- **Project budgets**: issue screen shows budget use; alerts at the warning % (default 80); issues above 100% need FM approval.
- **Physical stock count**: blind count on phone (scan or search), found items, variances → FM-approved stock adjustment.
- **QR labels & scanning**: A4 sticker sheets (3×8) for lots, items/bins and tools; scan with phone camera or USB scanner from the top bar or while counting.
- **Excel import**: templates for Items, Vendors and Opening stock (opening stock becomes a draft GRN for Stores to post); rows are validated before import.
- **Notifications**: in-app bell; every approval step notifies the next approver's role and informs the requester of approvals/rejections.
- **Finance — payables**: vendor invoices (3-way match), payment vouchers (bank, cheque, PDC, cash, LC, advances), debit notes, net payables with aging.
- **Finance — receivables**: customers master; project billing terms (advance %, advance recovery %, retention %, payment terms); sales invoices: advance invoice, progress claims filled from
  BOQ / unit progress (previous certified, cumulative, this claim) → submitted to the client → **payment certificate** (certified cumulative qty per line) → posted tax invoice with advance recovery,
  retention and VAT on (certified − recovery); final account, retention release, general sales and credit notes; customer receipts (bank, cheque, PDC with clearing / returned cheques) allocated to invoices;
  project billing summary (earned vs certified, unbilled work), receivables aging, customer statements; tax invoice / payment application / receipt PDFs.
- **General ledger**: UAE chart of accounts (editable; system accounts drive automatic postings); every module posts journals automatically every 15 minutes or on demand — stock receipts / issues / adjustments /
  production receipts / deliveries, production labour + machine + overhead absorbed into WIP, production scrap, service certificates, site installation & snag labour, supplier invoices, debit notes,
  payments and returned cheques, scrap sales, salary advances, payroll accrual and payment, sales invoices and receipts; manual journals with reversal; month end (depreciation by asset class useful life,
  gratuity & leave-salary provision true-up); period close / reopen; trial balance, P&L, balance sheet, ledgers with bank reconciliation ticks, FTA VAT 201 return.
- **Reports**: stock in hand, by lot/location, stock-out, overstock & non-moving, TOC buffer status, aging, ABC, valuation by category, project consumption, expiry, payables, open invoices, GRN-not-invoiced, tools with workers, calibration, stock ledger.
- **PDFs**: PO, GRN, material request, **issue slip**, return notes, transfer, count sheet, scrap note, disposal gate pass, debit note, payment voucher.

## Valuation
Per item class: Raw materials **FIFO**; consumables, packing, spares, scrap **weighted average**; machines/tools/equipment **fixed assets at landed cost**. An item may override FIFO/WAVG until it has transactions.

## Roles
Administrator, Purchase, Stores, Shop Floor, Production In-charge, Site Supervisor, HR Officer, Factory Manager, Finance Manager. Shop Floor, Production In-charge, Site Supervisor and HR Officer do not see costs.
Finance posts to the ledger; the Factory Manager can read the books and prepare claims.

## Desktop icon (any staff PC)
```
powershell -ExecutionPolicy Bypass -File tools/create-shortcut.ps1
```
Creates a **CitiCore** icon on the desktop that opens the live app in its own window (Edge app mode, Chrome as fallback).

## Run locally
```
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```
Open http://localhost:8080

## Deploy (Railway)
Railway builds the `Dockerfile` (Caddy serving `web/`). Connect the GitHub repo in Railway → *New Project → Deploy from GitHub repo*, then *Settings → Networking → Generate Domain*. Add that domain to Supabase → Authentication → URL Configuration (Site URL + Redirect URLs).

## Database migrations
`supabase/migrations/001…039` — already applied to the Supabase project, kept here as the source of truth.
