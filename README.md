# CitiCore — Citi Homes operations platform

Cloud system for **Citi Homes Kitchen and Wooden Furniture Manufacturing LLC** (UAE): purchasing, stores & inventory, production,
projects & site (BOQ, installation, snags, variations), HR / payroll and accounting (general ledger, customer billing, VAT).

**Live app:** https://samarpan060891.github.io/CH-IMS/

| Layer | Where |
|---|---|
| Database, logins, business rules | Supabase project `vvkkvudwbolhuveuxorc` (Mumbai) |
| Web app (static HTML/JS, no build step) | `web/` — published free on GitHub Pages |
| Admin user function | `supabase/functions/admin-users` |

## Modules
- **Masters**: items (class, category, UoM, specs, TOC buffer, MOQ, re-order, lead time), vendors (TRN, trade licence, payment terms, bank), locations (warehouse → zone → rack → bin), projects & make-to-stock orders, employees, cost centres, payment terms, vendor price list.
- **Purchase**: requisitions → purchase orders (Factory Manager → Finance → top-management reference) → release; replenishment suggestions from TOC buffers / re-order levels.
- **Stores**: GRN against PO or non-PO / opening / customer-supplied / samples, landed cost (freight, customs, clearing), lots & batches, expiry; FIFO/FEFO issues to projects, MTS orders or cost centres; returns from floor; transfers; physical count adjustments (FM approval); purchase returns.
- **Shop floor**: material requests approved by the Production In-charge. Phone-first **Floor app** (Shop floor → 📱 Floor app, or give users the "Floor app" dashboard):
  raise a request for a production order / project / MTS / cost centre by searching or scanning item, board or offcut labels, with +/− quantities and
  "offcuts that fit" the chosen order; follow my requests; In-charge approves / rejects on the phone; confirm material received (all OK or short / damaged);
  **return to store** against an issue slip — whole items (good / damaged) and **offcut pieces** measured on the spot (L × W or L, pieces); the In-charge
  marks each offcut keep / scrap and the Factory Manager approves, both from the phone's Approve tab.
- **Production**: work centres master (machine / labour rates, add any number); BOM templates for standard products (cut list, hardware, route per unit); production orders for projects or MTS with cut list (Excel/CSV import, template or manual), board yield & waste % → sheets and edge-band metres; release creates the material request; job card PDF with QR; stage board where supervisors log the crew by worker grade (grade × workers × normal + overtime hours, each grade has its own normal and overtime AED/hour rate); machine downtime log (breakdowns, planned maintenance, stoppages) feeding work-centre availability and load; QC rejects go to the Factory Manager for approval (accept / rework / scrap); job costing (material + labour + machine + overhead %); finished goods go to the FG store in batches or a final receipt that absorbs all remaining cost; QC rejects become a rework order (carrying their cost) or a scrap note (cost written off); dispatch notes (full or partial) charge the project; contract value on projects and selling value on orders give margin reports.
- **Machine-rate calculator** (Production): per machine work centre over a chosen period — depreciation of the machines linked to it (asset register)
  + breakdown repair costs (downtime log) + repair / spares / service expenses tagged to the machine + tooling allowance, ÷ machine hours logged on
  production orders (or planned capacity hours), + power per running hour (kW × load % × tariff in Settings). Shows current vs suggested rates;
  the Factory Manager / Finance applies a rate (future stage logs only) with a kept history.
- **Projects**: several projects run together, each with a BOQ of made in-house (→ production orders), bought-out (factory store or direct to site) and service lines (own installation team, subcontractors, hired transport); unit codes with lines attached by unit type or unit codes; billing basis per BOQ item or unit-wise (billable value exported to the accounting system); BOQ Excel import (BOQ + Units sheets); services as non-stock items through PO → work-done certificate → invoice; own-team installation logs (crew by grade incl. overtime, qty per BOQ line / unit); unit snagging / handover; BOQ and unit progress; project cost & margin; material planning (MRP) across all running projects with project-specific requisitions; BOQ baseline lock with numbered variation orders (add / change / omit, Factory Manager approval, contract value updated); Site Supervisor role (site-store receipts and handovers, delivery confirmation, installation logs, unit handover, site material requests); running-projects overview on the dashboard.
- **HR & payroll (UAE)**: HR Officer role; employee profile, documents with files and daily expiry alerts; salary & bank (visible to HR / Finance / admin only);
  daily attendance & overtime (125% / 150%); leave with UAE accrual and half-pay / unpaid sick leave; salary advances (Finance approves); monthly payroll (HR calculates,
  Finance approves / returns, marks paid), payslips PDF, WPS SIF file; gratuity & leave provision and end-of-service calculation (Decree-Law 33/2021).
- **Snags & site app**: snag list per unit with phone-camera photos (private storage), site supervisor fixes (rework crew costed), Production In-charge / FM verifies or reopens; no handover with open snags; snag register; phone-first **Site app** (units, log work, snags, deliveries to confirm) that site supervisors land on.
- **Tool crib & assets**: machines, power/hand/measuring tools, office and labour-accommodation equipment get an asset tag per unit; issue/return to workers, overdue tracking, calibration.
- **Scrap**: scrap generation and write-off (FM approval), scrap-yard stock, disposal / sale with gate pass (Factory Manager → Finance confirms rates & receipt).
- **Offcuts (panels & timber)**: a part-used sheet or length comes back on a material return as an offcut with its size (L × W, or L for timber) and number of pieces;
  it is valued pro-rata to the full sheet / length (item master size) and credited to the job. The Production In-charge proposes keep or scrap for each offcut,
  the Factory Manager approves (or sends back), then Stores receives: kept pieces become individual offcut lots with their size and QR label (Labels → Offcuts);
  scrapped pieces stay charged to the job. Offcuts are never picked automatically and are issued as whole pieces; they are listed first in the issue's
  batch / offcut choice, and production orders show offcuts in stock that fit cut-list parts (best fit first, grain respected). Free stock and replenishment ignore offcuts.
  Offcut stock report; offcut value / pieces available as KPI-card measures.
  Material requests can name the exact **board lot or offcut piece** (✂ Request offcuts lists pieces that fit the linked production order); offcuts are requested whole
  and only on one open request at a time; the issue made from the request takes exactly that piece and its store location.
- **Project vs stock purchasing**: every requisition / PO / GRN line is either for general stock or for a named project. Project lines create stock **reserved** for that project (only its issues can use it; own stock is issued first). Leftovers go back to general stock through an FM-approved **Project stock release**. Buffers and re-order suggestions use free stock and stock POs only.
- **Project budgets**: issue screen shows budget use; alerts at the warning % (default 80); issues above 100% need FM approval.
- **Receive app (phone)** (Inventory → 📱 Receive app, or the "Receive app" dashboard): open released POs (late ones flagged) → receiving location, DN no. / date,
  vehicle; per line DN qty, received and damaged with − / + and a live preview of what goes to stock / quarantine (damaged, excess) and short vs DN; batch and
  expiry asked only for items that require them (expiry filled from mfg date + shelf life); scan an item label to jump to its line; **Save draft** (add landed costs
  on the desktop) or **Receive & post**; drafts list with Post; lot labels after posting. Site supervisors receive into site stores.
- **Physical stock count**: blind count on phone (scan or search), found items, variances → FM-approved stock adjustment.
  Phone **Count app** (Inventory → 📱 Count app, or the "Count app" dashboard): counts in progress with progress bars; To count / Counted filters,
  scan a label to jump to its line, − / + steppers, ⏭ next uncounted, offcut pieces shown with their size and counted as here / missing; add found items; submit.
- **QR labels & scanning**: A4 sticker sheets (3×8) for lots, items/bins and tools; scan with phone camera or USB scanner from the top bar or while counting.
- **Excel import**: templates for Items, Vendors and Opening stock (opening stock becomes a draft GRN for Stores to post); rows are validated before import.
- **My approvals (phone inbox)**: one screen (sidebar → My approvals, or the "Approvals inbox" dashboard) listing everything waiting for the signed-in person's
  decision, with filter chips and approve / reject on each card — FM: POs, over-budget issues, stock adjustments, scrap notes, QC rejects, offcuts, stock releases,
  variation orders, snags to verify, scrap disposals, leave; Finance: POs, top-management references, stock releases, disposals, salary advances, payroll;
  Production In-charge: material requests, offcut keep / scrap, snags; Purchase: top-management references; HR: leave. "Open" goes to the full document.
- **Notifications**: in-app bell; every approval step notifies the next approver's role and informs the requester of approvals/rejections.
- **Running expenses** (Finance → Expenses): utilities, rent, telecom, fuel, repairs, fees … as expense vouchers of four kinds — **supplier bill** (posted as a
  supplier invoice → payables, paid through Payments), **paid now** (bank / card / cash), **petty cash** (per-float ledger accounts, top-ups) and **employee claim**
  (owed to the employee until reimbursed). Each line → expense head + cost centre (+ optional project, which then counts in project margin); bill photo / PDF
  attached from the phone; above the approval limit (Settings) the Factory Manager approves, Finance posts. Staff can raise claims and petty-cash spends.
  **Recurring bills** create a monthly draft to check against the actual bill. **Budgets** per cost centre / expense head / month with budget vs actual;
  **factory overheads vs absorbed** compares actual factory overheads (flagged expense heads + factory cost centres) with the overhead % absorbed into
  production orders and suggests the % that would cover them. Expense register; KPI measures for expenses and petty cash. Supplier invoices keyed by hand
  carry an expense head / cost centre / project on non-stock lines.
- **Provisions & accruals** (Finance → General ledger): always at month end — depreciation, gratuity and leave-salary provisions. Optional, each **off until
  Finance switches it on** ("Automate at month end"), and always available to preview and post by hand for any month:
  **accruals** for bills not yet received (suggested from recurring bills; post at month end and reverse themselves on the 1st), **prepayments** spread over
  months (expense lines can say "spread over N months"; monthly release, catches up late schedules), **doubtful debts** (% by days overdue),
  **slow-moving stock** (% by days in stock), **warranty / defects** (% of contract revenue in the defects period less snag rework) and **contract work done
  not yet billed** (unbilled earned value). The four provisions are true-ups to a target balance, so re-running a month posts nothing extra. Percentages
  and periods are picked by Finance on the page.
- **Cash position & forecast** (Finance → Cash): cash, bank and petty cash today, cheques in hand and PDCs issued; a rolling 13-week and 12-month forecast built from
  open customer invoices (moved by each customer's average days late; overdue spread over 4 weeks), PDCs by cheque date, sales-order and project advances and balances,
  unbilled project work, supplier invoices, open POs (advance now, balance at delivery + terms), payroll (last run repeated), recurring bills and VAT (28th after each
  quarter), plus Finance's own items (loans, capex, owner drawings; one-off or monthly). Click any amount for the documents behind it. Finance sets a minimum cash
  balance; weeks below it turn red and a daily check notifies Finance and the Factory Manager.
- **Requests for quotation (Purchase)**: from a requisition (📨 Request quotations) or new — items and quantities, suppliers invited (those already on the price
  list for the items are added automatically), RFQ PDF per supplier; quotes (rate, lead time, currency) entered side by side with the lowest price per line in green;
  award each line (Award lowest, or a dearer but faster supplier); Create POs makes one draft PO per supplier linked to the requisition lines, and the winning prices
  go on the vendor price list.
- **Maintenance costing**: cost centres MNT-MAC (machines) and MNT-FAC (factory building & facilities), both factory cost centres; office maintenance on ADM.
  Machine spares requested / issued to MNT-MAC can name the machine, as can repair bills and AMC recurring bills; these plus breakdown repair costs, depreciation and
  tooling make up each machine's rate in the machine-rate calculator. Building upkeep reaches products through the overhead % (factory overheads vs absorbed).
  The **Maintenance** menu gathers breakdowns & planned stops, spares requests (phone and desk), repair bills, AMC contracts, machines, tool crib, the
  machine-rate calculator and the reports *Maintenance cost by machine* (stops, hours down, breakdown repairs, bills / AMC and net store spares per month),
  downtime analysis and calibration due.
- **Preventive maintenance**: a *PM schedule* per machine is due every N days and/or every N running hours (machine hours logged on production and
  job-work orders), whichever comes first, with a checklist and a standard spares list, done in-house or by the AMC vendor. Each morning (07:00) — or when a
  schedule is saved — due schedules get a *PM job* a few lead days ahead plus a planned stop on the machine (so work-centre load sees it); the Production
  In-charge and FM are notified. On the job the team presses Start (machine down now), ticks the checklist, raises the spares request (cost centre MNT-MAC,
  tagged to the machine), records who did it and the hours (costed at the grade rate) or the vendor's service report. The Production In-charge closes it
  (all tasks ticked) — the stop ends and the schedule rolls on; *Cancel / skip* moves to the next cycle. Reports: *PM due list*; *Maintenance cost by machine*
  now splits breakdowns from PM and adds in-house PM labour. Job cards print from the 🖨 button.
- **Documents & PDFs**: every document prints into a panel that slides in from the right (pages drawn on screen, also on phones) with Download, Print and Open in new
  tab; the 👁 button on each list row previews a document's PDF without opening it (quotations, sales / project orders, RFQs, POs, GRNs, job cards, delivery notes,
  sales and purchase invoices, vouchers, payslips, labels …).
- **Finance — payables**: vendor invoices (3-way match), payment vouchers (bank, cheque, PDC, cash, LC, advances), debit notes, net payables with aging.
- **Finance — receivables**: customers master; project billing terms (advance %, advance recovery %, retention %, payment terms); sales invoices: advance invoice, progress claims filled from
  BOQ / unit progress (previous certified, cumulative, this claim) → submitted to the client → **payment certificate** (certified cumulative qty per line) → posted tax invoice with advance recovery,
  retention and VAT on (certified − recovery); final account, retention release, general sales and credit notes; customer receipts (bank, cheque, PDC with clearing / returned cheques) allocated to invoices;
  project billing summary (earned vs certified, unbilled work), receivables aging, customer statements; tax invoice / payment application / receipt PDFs.
- **General ledger**: UAE chart of accounts (editable; system accounts drive automatic postings); every module posts journals automatically every 15 minutes or on demand — stock receipts / issues / adjustments /
  production receipts / deliveries, production labour + machine + overhead absorbed into WIP, production scrap, service certificates, site installation & snag labour, supplier invoices, debit notes,
  payments and returned cheques, scrap sales, salary advances, payroll accrual and payment, sales invoices and receipts; manual journals with reversal; month end (depreciation by asset class useful life,
  gratuity & leave-salary provision true-up); period close / reopen; trial balance, P&L, balance sheet, ledgers with bank reconciliation ticks, FTA VAT 201 return.
- **Sales**: quotations (revisions, PDF, won / lost with reason) → sales order on acceptance. Order lines are made-in-house products (a draft production order
  is created on confirmation), stock / trading items, services, or job work (machine hours sold on a work centre, logged and costed at its rates + overhead).
  Customer orders: advance invoice, delivery notes against the order lines, tax invoices for what is delivered / done (advance recovered pro rata, the rest on the last
  invoice), order delivery, billing & margin report, Sales dashboard and a Sales role. **Internal orders** (mock-ups, internal use) are approved by the Factory Manager
  and charged to a cost centre. Each confirmed order collects its cost on a job with the order number.
  **Customer projects also start in Sales**: a quotation for a Project (BOQ ref, unit type / codes, qty per unit, bought-out to factory or site, service by own
  team / subcontractor, retention %, advance recovery %, billing basis) → project order → on confirmation the project (PRJ-nnnn) is created with that BOQ and contract
  terms; production, purchasing, delivery, installation and progress billing (advance, claims, certificates, retention) then run in the project.
- **Material requests** are raised for a customer project, a sales order, an internal order, a production order or make-to-stock — or, for consumables,
  packing and machine spares only (item classes marked "can be issued to a cost centre"), straight to a cost centre such as the factory or maintenance. Items are found by class →
  category → sub-category (or search / scan), each showing stock free, already reserved for this project / order, and reserved for other projects (not usable).
- **Master data — no typed-in parameters**: suppliers, customers, accounts / cost heads, cost centres, items, units of measure, projects, employees and work centres are always
  picked from their masters; departments, designations, nationalities, accommodation, banks, brands, unit types and rooms / areas from **Drop-down lists** (Masters), kept by
  HR, Finance, Stores / Purchase or the Factory Manager. Expense payees are suppliers, scrap buyers are customers, drivers / team leaders / "returned by" are employees (or a
  hired transporter / subcontractor), currencies and provision %s are fixed choices. When something is missing, the bottom of every drop-down offers **➕ Request a new …**:
  the request (Masters → Requests for new entries, also in My approvals) notifies the people who keep that master; they create it (or add the list value in one click) and
  mark it done, and the requester is told it can now be selected. The keepers themselves see **➕ Add a new …** instead. Old typed-in values still show, marked "not in the list".
- **Reports**: stock in hand, by lot/location, stock-out, overstock & non-moving, TOC buffer status, aging, ABC, valuation by category, project consumption, expiry, payables, open invoices, GRN-not-invoiced, tools with workers, calibration, stock ledger.
- **PDFs**: PO, GRN, material request, **issue slip**, return notes, transfer, count sheet, scrap note, disposal gate pass, debit note, payment voucher.

## Dashboards
Each user lands on the dashboard of their role:
- **Management (Factory Manager):** approvals, running projects, stock / payables / receivables KPIs, production, budgets, stock charts.
- **Finance:** bank, cash and cheques in hand, receivables, payables, revenue, profit, VAT, unbilled work, project billing.
- **Purchase:** stock-outs, red buffers, items to order, open and late POs.
- **Stores:** stock KPIs, expiring lots, charts, valuation.
- **Production (In-charge, Shop Floor):** open and late orders, stages, QC, machines down, work-centre load.
- **HR:** headcount, attendance today, leave, expiring documents, payroll status.
- **Site Supervisor:** lands on the Site app.

The Administrator has a **Dashboards** menu with every dashboard, showing each role's approvals.
In **Users & roles** the Administrator can tick which dashboards each user sees (none ticked = the role's default); users with more than one get a Dashboards menu.
Each user can **✎ Customise** their own dashboards: add or remove sections (from the dashboards they have been given), change the order by dragging (sections on the dashboard or rows in the panel; ↑ ↓ on phones), resize sections (width ¼ – full, height auto / short / medium / tall with scrolling), choose the dashboard
that opens at sign-in, or reset to the standard layout. **★ New KPI card** adds a user's own figure: pick a measure (33 measures across stores, purchasing,
production, projects, finance and HR — only those of the user's dashboards, money measures only for users who see costs), a period (today … all time, compared with
the previous period), an optional project and a goal (card turns green / red). Cards are shared by all of the user's dashboards and can be dragged and resized like any section. These settings are personal (stored on the user's profile).

## Valuation
Per item class: Raw materials **FIFO**; consumables, packing, spares, scrap **weighted average**; machines/tools/equipment **fixed assets at landed cost**. An item may override FIFO/WAVG until it has transactions.

## Roles
Administrator, Purchase, Stores, Shop Floor, Production In-charge, Site Supervisor, HR Officer, Factory Manager, Finance Manager, Sales. Shop Floor, Production In-charge, Site Supervisor and HR Officer do not see costs.
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

## Deploy (GitHub Pages — free)
`.github/workflows/pages.yml` publishes the `web/` folder to https://samarpan060891.github.io/CH-IMS/ on every push to `main` that changes `web/`
(watch it under the repo's **Actions** tab; it takes about a minute). One-time setup: GitHub repo → *Settings → Pages → Build and deployment → Source: GitHub Actions*,
and add the address to Supabase → Authentication → URL Configuration (Site URL + Redirect URLs).
The `Dockerfile` / `Caddyfile` (Caddy serving `web/`) still work for any container host, e.g. Railway, if ever needed.

## Database migrations
`supabase/migrations/001…039` — already applied to the Supabase project, kept here as the source of truth.
