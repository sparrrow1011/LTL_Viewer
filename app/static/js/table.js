// Table Management
class TableManager {
  constructor() {
    this.state = {
      rows: [],
      filtered: [],
      headers: [],
      page: 1,
      perPage: 20,
      sortKey: null,
      sortDirection: 'asc'
    };

    this.elements = {
      thead: document.getElementById('thead-row'),
      tbody: document.getElementById('tbody'),
      empty: document.getElementById('empty'),
      count: document.getElementById('count'),
      updated: document.getElementById('updated')
    };
    this.fetchSequence = 0;

    this.pageColumns = {
      planned: ['vrid', 'vehicle_carrier', 'vehicle_execution_status'],
      rlb1: ['shippername', 'tour_id', 'vrid', 'orig_planned_yard_checkin_time', 'orig_node', 'dest_node', 'orig_country', 'dest_country', 'vehicle_carrier', 'vehicle_execution_status'],
      manual_sourced: ['shippername', 'vrid', 'manual_source_by', 'manual_source_date', 'orig_planned_yard_checkin_time', 'orig_country', 'dest_country', 'sims'],
      default: ['shippername', 'tour_id', 'vrid', 'isa', 'vehicle_execution_status', 'orig_planned_yard_checkin_time', 'vehicle_carrier', 'orig_country', 'dest_country'],
      auditing_uncovered: ['orderid', 'shippername', 'orig_planned_yard_checkin_time', 'creation_date_and_time', 'uncovered_status', 'date_downloaded', 'uncovered_owner'],
      auditing_misaligned: ['orderid', 'vrid', 'isa', 'destination_stop_date_and_time',  'dest_planned_yard_checkin_time','isa_current_crdd', 'misaligned_status', 'misaligned_comment', 'misaligned_owner', 'date_downloaded', 'isa_site'],
      scheduling_tracker: ['vrid', 'orderid', 'shippername', 'createdby', 'createdat', 'book_date_utc', 'booked_by_csv', 'lane_src_1','ordercreationsource', 'origin_code', 'dest_code'],
      driver_details: ['shippername', 'vrid', 'order_id', 'orig_code', 'dest_code', 'orig_planned_checkin_time', 'driver'],
      cfet: ['shippername', 'tour_id', 'vrid', 'isa', 'vehicle_execution_status', 'shipper_account', 'orig_planned_yard_checkin_time', 'vehicle_carrier', 'orig_country', 'dest_country']
      // auditing_ncns: ['orderid', 'shippername', 'orig_planned_yard_checkin_time', 'creation_date_and_time', 'ncns_status', 'date_downloaded', 'ncns_owner']
    };

    this.currentPage = window.currentPage || 'default';
    this.init();
  }

  reset() {
    this.state.headers = [];
    this.state.rows = [];
    this.state.filtered = [];
    this.state.page = 1;
    this.state.sortKey = null;
    this.state.sortDirection = 'asc';

    document.getElementById('thead-row').innerHTML = '';
    document.getElementById('tbody').innerHTML = '';
    console.log(window.currentPage);
  }



  init() {
    this.setupPageSpecificFilters();
    this.fetchData();
  }

  setupPageSpecificFilters() {
    const path = window.location.pathname;
    const urlParams = new URLSearchParams(window.location.search);
    const today = new Date().toISOString().split('T')[0];

    if (path.includes('/planned')) {
      this.currentPage = 'planned';
      Utils.updateURLParams({ vehicle_execution_status: 'PLANNED' });

    } else if (path.includes('/manual-sourcing')) {
      this.currentPage = 'rlb1';
      // LTL data isn't restricted to specific carriers/status/today — show
      // everything by default; the user narrows with the filter controls.

    } else if (path.includes('/manual-sourced-runs')) {
      this.currentPage = 'manual_sourced';
      Utils.updateURLParams({ is_manual_source: 1 });
    } else if (path.includes('/all-runs')) {
      if (!urlParams.has('start_date') && !urlParams.has('end_date')) {
        Utils.updateURLParams({ start_date: today, end_date: today });
      }
    } else if (path.includes('/cfet')) {
      this.currentPage = 'cfet';
      if (!urlParams.has('start_date') && !urlParams.has('end_date')) {
        Utils.updateURLParams({ start_date: today, end_date: today });
      }
    }
  }

  //  Fetch data using correct multi-value params

  async fetchData() {
    if (!this.elements.thead) return;
    const requestId = ++this.fetchSequence;

    try {
      Utils.showLoading();

      // Get URL parameters with arrays preserved
      const params = Utils.getURLParams();
      params.page = this.currentPage;

      // Call backend with these params
      const data = await window.apiManager.getTableData(params);
      if (requestId !== this.fetchSequence) return;

      this.state.rows = Array.isArray(data) ? data : [];
      this.buildHeaders();
      this.applySearch(); // Render the table

      if (this.elements.updated) {
        this.elements.updated.textContent = `Updated: ${new Date().toLocaleString()}`;
      }

    } catch (error) {
      if (requestId !== this.fetchSequence) return;
      console.error('Failed to fetch data:', error);
      Utils.showToast('Failed to load data', 'error');
    } finally {
      if (requestId === this.fetchSequence) {
        Utils.hideLoading();
      }
    }
  }
  buildHeaders() {
    if (!this.elements.thead || !this.state.rows.length) return;

    this.state.headers = Object.keys(this.state.rows[0]);
    this.renderHeaders();
  }

  renderHeaders() {
    if (!this.elements.thead) return;

    this.elements.thead.innerHTML = '';

    const visibleColumns = this.pageColumns[this.currentPage] || this.state.headers;

    // Add select column for manual sourcing
    if (this.currentPage === 'rlb1') {
      const th = document.createElement('th');
      th.className = 'px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';
      th.innerHTML = `
        <input type="checkbox" id="selectAllHeader" class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500">
      `;
      this.elements.thead.appendChild(th);

      // Setup select all functionality
      const selectAllHeader = document.getElementById('selectAllHeader');
      if (selectAllHeader) {
        selectAllHeader.addEventListener('change', (e) => {
          const checkboxes = document.querySelectorAll('#tbody input[type=checkbox]');
          checkboxes.forEach(cb => cb.checked = e.target.checked);
          if (window.updateSelectedCount) {
            window.updateSelectedCount();
          }
        });
      }
    }


    visibleColumns.forEach(header => {
      const th = document.createElement('th');
      th.className = 'px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors';

      const sortIcon = this.getSortIcon(header);
      th.innerHTML = `
        <div class="flex items-center gap-2">
          <span>${header.replace(/_/g, ' ')}</span>
          <i class="${sortIcon}"></i>
        </div>
      `;

      th.addEventListener('click', () => this.sortBy(header));
      this.elements.thead.appendChild(th);
    });
    if (this.currentPage === 'default' || this.currentPage === 'manual_sourced') {
      const th = document.createElement('th');
      th.className = 'px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
      th.textContent = 'Manual Sourced';
      this.elements.thead.appendChild(th);
    }
    // Add actions column for manual sourcing
    if (this.currentPage === 'rlb1') {
      const th = document.createElement('th');
      th.className = 'px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';
      th.textContent = 'Actions';
      this.elements.thead.appendChild(th);
    }
  }


  getSortIcon(header) {
    if (this.state.sortKey !== header) {
      return 'fas fa-sort text-gray-400';
    }
    return this.state.sortDirection === 'asc' ?
      'fas fa-sort-up text-primary-600' :
      'fas fa-sort-down text-primary-600';
  }

  renderBody() {
    if (!this.elements.tbody) return;

    this.elements.tbody.innerHTML = '';

    if (!this.state.filtered.length) {
      if (this.elements.empty) {
        this.elements.empty.classList.remove('hidden');
      }
      if (this.elements.count) {
        this.elements.count.textContent = '0 rows';
      }
      return;
    }

    if (this.elements.empty) {
      this.elements.empty.classList.add('hidden');
    }

    const visibleColumns = this.pageColumns[this.currentPage] || this.state.headers;
    const showAllRows = this.currentPage === 'rlb1';
    const perPage = showAllRows ? Math.max(this.state.filtered.length, 1) : this.state.perPage;

    if (showAllRows) {
      // Show everything for manual sourcing instead of slicing to 20 rows
      this.state.page = 1;
      this.state.perPage = perPage;
    }

    const start = showAllRows ? 0 : (this.state.page - 1) * perPage;
    const end = showAllRows ? this.state.filtered.length : start + perPage;
    const pageRows = this.state.filtered.slice(start, end);

    pageRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors';

      // Add select checkbox for manual sourcing
      if (this.currentPage === 'rlb1') {
        const td = document.createElement('td');
        td.className = 'px-6 py-4 whitespace-nowrap';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'rounded row-select border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500';
        checkbox.dataset.vrid = row.vrid || '';
        // encodeURIComponent does not escape apostrophes; force-escape to keep data attributes valid.
        checkbox.dataset.row = encodeURIComponent(JSON.stringify(row)).replace(/'/g, '%27');
        checkbox.addEventListener('change', () => {
          if (window.updateSelectedCount) {
            window.updateSelectedCount();
          }
        });
        td.appendChild(checkbox);
        tr.appendChild(td);
      }




      // Add data columns
      visibleColumns.forEach(header => {
        const td = document.createElement('td');
        td.className = 'px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100';

        let value = row[header] ?? '';

        // 1️⃣ Date formatting
        if (isDateColumn(header)) {
          value = renderDateCell(value, header, row);
        }

        // 2️⃣ Uncovered status dropdown
        if (renderUncoveredStatusCell(td, header, value, row)) {
          tr.appendChild(td);
          return;
        }

        // 3️⃣ Misaligned status dropdown
        if (renderMisalignedStatusCell(td, header, value, row)) {
          tr.appendChild(td);
          return;
        }

        // 4️⃣ Misaligned highlighting
        applyMisalignedHighlight(td, header, row);

        // 5️⃣ Inline misaligned comment editor
        if (renderMisalignedCommentCell(td, header, value, row)) {
          tr.appendChild(td);
          return;
        }

        // 6️⃣ Links
        if (renderLinkCell(td, header, value, row)) {
          tr.appendChild(td);
          return;
        }

        // 7️⃣ Default render
        td.textContent = value;
        tr.appendChild(td);
      });

      function isDateColumn(header) {
        return [
          'orig_planned_yard_checkin_time',
          'orig_planned_checkin_time',
          'dest_planned_yard_checkin_time',
          'manual_source_date',
          'origin_stop_date_and_time',
          'destination_stop_date_and_time',
          'isa_current_crdd'
        ].includes(header);
      }

      function renderDateCell(value, header, row) {
        if (!value) return value;

        const countryFieldMap = {
          'orig_planned_yard_checkin_time': 'orig_country',
          'orig_planned_checkin_time':      'orig_country',
          'origin_stop_date_and_time':      'orig_country',
          'dest_planned_yard_checkin_time': 'dest_country',
          'destination_stop_date_and_time': 'dest_country',
        };

        if (header in countryFieldMap) {
          // Stored as UTC — append Z so new Date() parses correctly,
          // then convert to the appropriate local timezone.
          try {
            const utcStr = normalizeUtcDateString(value);
            const date = new Date(utcStr);
            if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
            const tz = row[countryFieldMap[header]] === 'GB' ? 'Europe/London' : 'Europe/Paris';
            const parts = new Intl.DateTimeFormat('en-GB', {
              timeZone: tz,
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', hour12: false
            }).formatToParts(date);
            const p = Object.fromEntries(parts.map(p => [p.type, p.value]));
            return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
          } catch (e) {
            // fall through
          }
        }

        // Fallback for non-location dates (manual_source_date, isa_current_crdd)
        if (!window.moment) return value;
        const parsed = moment(value);
        return parsed.isValid() ? parsed.local().format('DD-MM-YYYY HH:mm') : value;
      }

      function normalizeUtcDateString(value) {
        const raw = String(value).trim().replace(' ', 'T');
        return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
      }

      function renderUncoveredStatusCell(td, header, value, row) {
        if (window.currentPage !== 'auditing_uncovered') return false;
        if (header !== 'uncovered_status') return false;

        const select = document.createElement('select');
        select.className = 'px-2 py-1 rounded bg-white dark:bg-gray-700 text-sm';

        [
          'Pending',
          'In Progress',
          'Under Query',
          'Completed',
          'Cancelled',
          'No Action Required'
        ].forEach(s => {
          const o = document.createElement('option');
          o.value = s;
          o.textContent = s;
          if (s === (value || 'Pending')) o.selected = true;
          select.appendChild(o);
        });

        select.onchange = async () => {
          await window.pywebview.api.update_uncovered_status(
            row.orderid,
            select.value,
            window.currentUser || 'unknown'
          );
          row.uncovered_status = select.value;
          if (window.tableManager) {
            window.tableManager.fetchData();
          }
          Utils.showToast('Status updated', 'success');
        };

        td.appendChild(select);
        return true;
      }

      function renderMisalignedStatusCell(td, header, value, row) {
        if (window.currentPage !== 'auditing_misaligned') return false;
        if (header !== 'misaligned_status') return false;

        const select = document.createElement('select');
        select.className = 'px-2 py-1 rounded bg-white dark:bg-gray-700 text-sm';

        const baseOptions = [
          'Pending',
          'In Progress',
          'Under Query',
          'Completed',
          'Cancelled',
          'No Action Required'
        ];
        const options = [...new Set([...(window.misalignedStatusOptions || []), ...baseOptions])];

        const uniqueOptions = new Set(options);
        if (value && !uniqueOptions.has(value)) {
          uniqueOptions.add(value);
        }

        [...uniqueOptions].forEach(s => {
          const o = document.createElement('option');
          o.value = s;
          o.textContent = s;
          if (s === (value || 'Pending')) o.selected = true;
          select.appendChild(o);
        });

        select.onchange = async () => {
          const payload = {
            order_id: row.orderid,
            order_status: select.value,
            comment: row.misaligned_comment || '',
            owner: window.currentUser || 'unknown'
          };
          try {
            if (window.pywebview?.api?.update_misaligned_status) {
              await window.pywebview.api.update_misaligned_status(
                payload.order_id,
                payload.order_status,
                payload.comment,
                payload.owner
              );
            } else {
              await fetch('/api/auditing/misaligned/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
            }
            row.misaligned_status = select.value;
            row.misaligned_owner = payload.owner;
            if (window.tableManager) {
              window.tableManager.fetchData();
            }
            Utils.showToast('Status updated', 'success');
          } catch (err) {
            Utils.showToast('Failed to update status', 'error');
            console.error(err);
          }
        };

        td.appendChild(select);
        return true;
      }


      function applyMisalignedHighlight(td, header, row) {
        if (window.currentPage !== 'auditing_misaligned') return;

        const keys = [
          'destination_stop_date_and_time',
          'isa_current_crdd',
          'dest_planned_yard_checkin_time'
        ];

        if (!keys.includes(header)) return;

        const values = keys.map(k => row[k]).filter(Boolean);
        const unique = new Set(values.map(v => String(v)));

        if (unique.size > 1) {
          td.classList.add(
            'bg-yellow-100',
            'dark:bg-yellow-900/40',
            'font-semibold'
          );
        }
      }

      function renderMisalignedCommentCell(td, header, value, row) {
        if (window.currentPage !== 'auditing_misaligned') return false;
        if (header !== 'misaligned_comment') return false;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
        input.placeholder = 'Add comment...';
        input.className = `
    w-full px-2 py-1 rounded border
    border-gray-300 dark:border-gray-600
    bg-white dark:bg-gray-700
    text-sm
  `;

        let timeout;
        input.oninput = () => {
          clearTimeout(timeout);
          timeout = setTimeout(async () => {
            const payload = {
              order_id: row.orderid,
              order_status: row.misaligned_status || 'Pending',
              comment: input.value,
              owner: window.currentUser || 'unknown'
            };
            try {
              if (window.pywebview?.api?.update_misaligned_status) {
                await window.pywebview.api.update_misaligned_status(
                  payload.order_id,
                  payload.order_status,
                  payload.comment,
                  payload.owner
                );
              } else {
                await fetch('/api/auditing/misaligned/update-status', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload)
                });
              }
              row.misaligned_comment = payload.comment;
              row.misaligned_owner = payload.owner;
              if (window.tableManager) {
                window.tableManager.fetchData();
              }
              Utils.showToast('Comment saved', 'success');
            } catch (err) {
              Utils.showToast('Failed to save comment', 'error');
              console.error(err);
            }
          }, 600);
        };

        td.appendChild(input);
        return true;
      }
      function renderLinkCell(td, header, value, row) {
        if (!value) return false;

        let href = null;

        if (header === 'orderid') {
          href = `https://smc-eu-dub.dub.proxy.amazon.com/order/${value}`;
        }

        if (header === 'vrid') {
          href = `https://trans-logistics-eu.amazon.com/fmc/execution/search/${value}`;
        }

        if (header === 'tour_id') {
          href = `https://trans-logistics-eu.amazon.com/fmc/execution/search/${value}`;
        }

        if (header === 'isa') {
          const site = row?.isa_site || row?.isaSite || row?.site || row?.fc;
          if (site) {
            href = `https://fc-inbound-dock-hub-eu.aka.amazon.com/en_US/#/dockmaster/appointment/${encodeURIComponent(site)}/view/${encodeURIComponent(value)}/appointmentDetail`;
          } else {
            href = `https://unified-portal-eu.corp.amazon.com/#/appointment?searchType=APPOINTMENT&searchCategory=appointment&searchIds=${encodeURIComponent(value)}`;
          }
        }

        if (!href) return false;

        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'text-blue-600 hover:underline';
        a.textContent = value;

        td.appendChild(a);
        return true;
      }


      // Add actions column for manual sourcing


      if (this.currentPage === 'rlb1') {
        const td = document.createElement('td');
        td.className = 'px-6 py-4 whitespace-nowrap text-sm';
        const emailGeneratedTooltip = row.email_generated_at
          ? `Generated at: ${row.email_generated_at}`
          : '';
        const emailSentTooltip = row.email_sent
          ? `Sent at: ${row.email_sent_confirmed_at}`
          : '';
        let statusHtml = `
          <span class="px-2 py-1 rounded text-xs font-semibold bg-gray-200 text-gray-700">
            Not Generated
          </span>`;

        // ✅ SENT (reversible)
        if (row.email_sent) {
          statusHtml = `
            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                class="email-sent-toggle"
                data-vrid="${row.vrid}"
                checked
              />
              <span class="px-2 py-1 rounded text-xs font-semibold bg-green-200 text-green-800">
                Sent ✅ (${row.email_sent_count || 1})
              </span>
            </div>`;
        }

        // 🟡 GENERATED BUT NOT SENT
        else if (row.email_generated_at) {
          statusHtml = `
    <div class="flex items-center gap-2">
      <input
        type="checkbox"
        class="email-sent-toggle"
        data-vrid="${row.vrid}"
      />
      <span
        class="px-2 py-1 rounded text-xs font-semibold bg-yellow-200 text-yellow-800"
        title="${emailGeneratedTooltip}"
      >
        Pending 📧 (${row.email_sent_count || 0})
      </span>
    </div>`;
        }

        if (row.email_sent) {
          statusHtml = `
    <div class="flex items-center gap-2">
      <input
        type="checkbox"
        class="email-sent-toggle"
        data-vrid="${row.vrid}"
        checked
      />
      <span
        class="px-2 py-1 rounded text-xs font-semibold bg-green-200 text-green-800"
        title="${emailSentTooltip}"
      >
        Sent ✅ (${row.email_sent_count || 1})
      </span>
    </div>`;
        }



        td.innerHTML = statusHtml;
        const emailToggle = td.querySelector('.email-sent-toggle');
        if (emailToggle) {
          emailToggle.addEventListener('change', async (e) => {
            const newValue = e.target.checked;
            const vrid = e.target.dataset.vrid;
            if (!vrid) {
              Utils.showToast('Missing VRID for email toggle', 'error');
              e.target.checked = !newValue;
              return;
            }

            try {
              const res = await fetch('/api/toggle-email-sent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vrid, value: newValue })
              });
              const json = await res.json();
              if (json.status === 'ok') {
                Utils.showToast('Email status updated', 'success');
                if (window.tableManager) {
                  window.tableManager.fetchData();
                }
              } else {
                Utils.showToast(json.message || 'Failed to update email status', 'error');
                e.target.checked = !newValue;
              }
            } catch (err) {
              console.error(err);
              Utils.showToast('Error updating email status', 'error');
              e.target.checked = !newValue;
            }
          });
        }
        if (!row.email_sent && row.email_generated_at) {
          const bulkSelect = document.createElement('input');
          bulkSelect.type = 'checkbox';
          bulkSelect.className = 'email-select';
          bulkSelect.value = row.vrid || '';
          bulkSelect.dataset.status = 'pending';
          bulkSelect.setAttribute('aria-label', 'Select pending email for bulk send');
          td.prepend(bulkSelect);
        }
        tr.appendChild(td);
      }

      if (this.currentPage === 'rlb1') {
        const td = document.createElement('td');
        td.className = 'px-6 py-4 whitespace-nowrap text-sm';


        let calculatorButton = `
          <button
            type="button"
            class="open-calculator px-4 py-2 ml-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg 
                  font-medium transition-colors text-sm"
            data-revenue="${row.revenue || 0}"
          >
            <i class="fas fa-calculator"></i>
          </button>`;



        td.innerHTML += calculatorButton;
        tr.appendChild(td);
      }


      if (this.currentPage === 'default' || this.currentPage === 'manual_sourced') {
        const td = document.createElement('td');
        td.className = 'px-6 py-4 whitespace-nowrap text-sm';
        td.innerHTML = `
        <input type="checkbox" class="toggle-manual-source" data-vrid="${row.vrid}" 
               ${row.is_manual_source ? 'checked' : ''}>
    `;
        const checkbox = td.querySelector('input');
        checkbox.addEventListener('change', async (e) => {
          const vrid = e.target.dataset.vrid;
          const newValue = e.target.checked;

          let sims = null;
          let ms_cost = null;

          if (newValue) {
            sims = prompt("Enter SIMS value before marking as manual source:");
            if (!sims) {
              alert("SIMS is required!");
              e.target.checked = false;
              return;
            }

            const costInput = prompt("Enter Manual Source Cost (€):");
            if (costInput !== null && costInput !== "") {
              const parsedCost = parseFloat(costInput);
              if (isNaN(parsedCost) || parsedCost < 0) {
                alert("Please enter a valid cost amount.");
                e.target.checked = false;
                return;
              }
              ms_cost = parsedCost;
            }
          }



          if (!confirm("Are you sure you want to change manual status for this VRID?")) {
            e.target.checked = !newValue; // revert
            return;
          }

          try {
            const res = await fetch("/api/toggle-manual-source", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                vrid,
                value: newValue,
                sims,
                ms_cost
              })  // send sims too
            });
            const json = await res.json();
            if (json.status === "ok") {
              Utils.showToast("Manual source updated", "success");
            } else {
              Utils.showToast(json.message || "Failed to update", "error");
              e.target.checked = !newValue; // revert
            }
          } catch (err) {
            console.error(err);
            Utils.showToast("Error updating manual source", "error");
            e.target.checked = !newValue; // revert
          }
        });

        tr.appendChild(td);
      }

      this.elements.tbody.appendChild(tr);
    });

    this.updateCount();
    this.renderPagination();
  }

  updateCount() {
    if (!this.elements.count) return;

    const totalPages = Math.ceil(this.state.filtered.length / this.state.perPage);
    this.elements.count.textContent =
      `${this.state.filtered.length} rows (Page ${this.state.page} of ${totalPages})`;
  }

  renderPagination() {
    let pagination = document.getElementById('pagination');
    if (!pagination) {
      pagination = document.createElement('div');
      pagination.id = 'pagination';
      pagination.className = 'flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700';

      const tableContainer = this.elements.tbody?.closest('.bg-white, .dark\\:bg-gray-800');
      if (tableContainer) {
        tableContainer.appendChild(pagination);
      }
    }

    const totalPages = Math.ceil(this.state.filtered.length / this.state.perPage);

    pagination.innerHTML = `
      <div class="flex items-center gap-2">
        <button id="prevPage" class="px-3 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" 
                ${this.state.page === 1 ? 'disabled' : ''}>
          <i class="fas fa-chevron-left mr-1"></i>Previous
        </button>
        <span class="text-sm text-gray-700 dark:text-gray-300">
          Page ${this.state.page} of ${totalPages}
        </span>
        <button id="nextPage" class="px-3 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" 
                ${this.state.page === totalPages ? 'disabled' : ''}>
          Next<i class="fas fa-chevron-right ml-1"></i>
        </button>
      </div>
    `;

    // Setup pagination event listeners
    document.getElementById('prevPage')?.addEventListener('click', () => {
      if (this.state.page > 1) {
        this.state.page--;
        this.renderBody();
      }
    });

    document.getElementById('nextPage')?.addEventListener('click', () => {
      if (this.state.page < totalPages) {
        this.state.page++;
        this.renderBody();
      }
    });
  }

  applySearch(searchTerm = '') {
    const raw = searchTerm.trim();
    if (!raw) {
      this.state.filtered = [...this.state.rows];
    } else {
      const terms = raw.split(',').map(s => s.trim()).filter(Boolean);
      const hasMultiTerms = terms.length > 1;
      const term = raw.toLowerCase();

      const lowerTerms = terms.map(t => t.toLowerCase());

      this.state.filtered = this.state.rows.filter(row => {
        if (hasMultiTerms) {
          const vrid = (row.vrid ?? '').toString().toLowerCase();
          const orderId = (row.orderid ?? row.order_id ?? '').toString().toLowerCase();
          return lowerTerms.some(t => (vrid && vrid === t) || (orderId && orderId === t));
        }

        return this.state.headers.some(header =>
          (row[header] || '').toString().toLowerCase().includes(term)
        );
      });
    }

    this.state.page = 1; // Reset to first page
    this.renderBody();
  }

  sortBy(key) {
    const direction = (this.state.sortKey === key && this.state.sortDirection === 'asc') ? 'desc' : 'asc';
    this.state.sortKey = key;
    this.state.sortDirection = direction;

    const multiplier = direction === 'asc' ? 1 : -1;

    this.state.filtered.sort((a, b) => {
      const valueA = a[key] || '';
      const valueB = b[key] || '';

      // Try numeric comparison first
      if (!isNaN(valueA) && !isNaN(valueB)) {
        return (parseFloat(valueA) - parseFloat(valueB)) * multiplier;
      }

      // Fall back to string comparison
      return valueA.toString().localeCompare(valueB.toString()) * multiplier;
    });

    this.renderHeaders(); // Update sort icons
    this.renderBody();
  }
}

// Global functions for email functionality
window.sendSingleEmail = function (row) {
  const subject = encodeURIComponent(`Follow-up on Load ${row.vrid || ""}`);
  const body = encodeURIComponent(
    `Hello Team,\n\nPlease review ${row.vrid || ""} for Manual Sourcing:\n\n` +
    `Execution Status: ${row.vehicle_execution_status || ""}\n` +
    `First Dock Arrival: ${row.orig_planned_yard_checkin_time || ""}\n\n` +
    `Last Dock Arrival: ${row.dest_planned_yard_checkin_time || ""}\n` +
    `Origin Country: ${row.orig_country || ""}\n` +
    `Origin Node: ${row.orig_node || ""}\n` +
    `Destination Country: ${row.dest_country || ""}\n` +
    `Destination Node: ${row.dest_node || ""}\n\n` +
    `Equipment Type: ${row.equipment_type || ""}\n` +
    `Best Regards,\nCustomer Success Team`
  );

  const mailtoLink = `mailto:?subject=${subject}&body=${body}`;
  window.location.href = mailtoLink;
  Utils.showToast('Email generated successfully', 'success');
};

// Initialize table manager
document.addEventListener('DOMContentLoaded', () => {
  window.tableManager = new TableManager();
});

