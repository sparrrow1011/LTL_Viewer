// Filter Management
class FilterManager {
  constructor() {
    this.filters = {};
    this.init();
  }

  toSundayISO(dateStr) {
    if (!dateStr) return '';
    // Supports both date input (YYYY-MM-DD) and week input (YYYY-Www).
    const weekMatch = /^(\d{4})-W(\d{2})$/.exec(dateStr);
    if (weekMatch) {
      const year = parseInt(weekMatch[1], 10);
      const week = parseInt(weekMatch[2], 10);
      if (Number.isNaN(year) || Number.isNaN(week)) return '';
      const monday = new Date(Date.UTC(year, 0, 4 + (week - 1) * 7));
      const mondayDay = monday.getUTCDay() || 7;
      monday.setUTCDate(monday.getUTCDate() - (mondayDay - 1));
      monday.setUTCDate(monday.getUTCDate() - 1); // Sunday
      return monday.toISOString().split('T')[0];
    }

    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    const daysSinceSunday = d.getDay(); // Sunday=0
    d.setDate(d.getDate() - daysSinceSunday);
    return d.toISOString().split('T')[0];
  }

  async init() {
    this.setupDateFilters();
    this.setupSearchFilter();
    this.loadFiltersFromURL();
    await this.populateDropdownFilters();
  }

setupDateFilters() {
  const startDate = document.getElementById('startDate');
  const endDate = document.getElementById('endDate');
  const manualSourceWeek = document.getElementById('manualSourceWeek');
  const applyButton = document.getElementById('applyFilter') || document.getElementById('applyDateRange');
  const path = window.location.pathname;
  const isManualSourcedRunsPage = path.includes('/manual-sourced-runs');

  if (startDate && endDate) {
    const today = new Date().toISOString().split('T')[0];
    const urlParams = new URLSearchParams(window.location.search);

    const urlStart = urlParams.get('start_date');
    const urlEnd = urlParams.get('end_date');
    const urlWeekStart = urlParams.get('manual_source_week_start');
    const urlWeek = urlParams.get('manual_source_week');
    const hasWeekInUrl = Boolean(urlWeekStart || urlWeek);

    // ✅ Only set default if input is empty
    if (!startDate.value && !(isManualSourcedRunsPage && hasWeekInUrl)) startDate.value = urlStart || today;
    if (!endDate.value && !(isManualSourcedRunsPage && hasWeekInUrl)) endDate.value = urlEnd || today;

    // ✅ Only update URL if empty
    if (!urlStart && !urlEnd && !(isManualSourcedRunsPage && hasWeekInUrl)) {
      Utils.updateURLParams({ start_date: startDate.value, end_date: endDate.value });
    }

    if (manualSourceWeek && urlWeekStart) {
      manualSourceWeek.value = this.toSundayISO(urlWeekStart) || urlWeekStart;
    } else if (manualSourceWeek && urlWeek) {
      const parts = urlWeek.split('-W');
      if (parts.length === 2) {
        const year = parseInt(parts[0], 10);
        const week = parseInt(parts[1], 10);
        if (!Number.isNaN(year) && !Number.isNaN(week)) {
          const monday = new Date(Date.UTC(year, 0, 4 + (week - 1) * 7));
          const mondayDay = monday.getUTCDay() || 7;
          monday.setUTCDate(monday.getUTCDate() - (mondayDay - 1));
          monday.setUTCDate(monday.getUTCDate() - 1); // Sunday
          manualSourceWeek.value = monday.toISOString().split('T')[0];
        }
      }
    }
    if (isManualSourcedRunsPage && manualSourceWeek) {
      manualSourceWeek.addEventListener('change', () => {
        if (manualSourceWeek.value) {
          startDate.value = '';
          endDate.value = '';
        }
        this.applyFilters();
      });
    }

    // Reapply filters when clicking Apply
    if (applyButton) {
      applyButton.addEventListener('click', () => this.applyFilters());
    }
  }
}


  setupSearchFilter() {
    const searchInput = document.getElementById('globalSearch');
    if (searchInput) {
      const debouncedSearch = Utils.debounce((value) => {
        this.applySearchFilter(value);
      }, 300);

      searchInput.addEventListener('input', (e) => {
        debouncedSearch(e.target.value);
      });
    }
  }

  loadFiltersFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    
    // Load country filter
    const country = urlParams.get('orig_country');
    if (country) {
      const countrySelect = document.getElementById('country');
      if (countrySelect) {
        countrySelect.value = country;
      }
    }

    // Load origin node filter
    const origNode = urlParams.get('orig_node');
    if (origNode) {
      const el = document.getElementById('origNode');
      if (el) el.value = origNode;
    }

    // Load destination node filter
    const destNode = urlParams.get('dest_node');
    if (destNode) {
      const el = document.getElementById('destNode');
      if (el) el.value = destNode;
    }


    // Load status filter
    const status = urlParams.get('vehicle_execution_status');
    if (status) {
      const statusSelect = document.getElementById('executionStatus');
      if (statusSelect) {
        statusSelect.value = status;
      }
    }
  }

  async populateDropdownFilters() {
    try {
      // Populate countries
      const countries = await window.apiManager.getDistinctCountries();
      this.populateSelect('country', countries, 'All Countries');

      // Populate statuses
      const statuses = await window.apiManager.getDistinctStatuses();
      this.populateSelect('executionStatus', statuses, 'All Statuses');

      await this.populateShipperFilter();
      await this.populateOrigNodeFilter();
      await this.populateDestNodeFilter();



      // Setup apply filter button
      const applyButton = document.getElementById('applyFilter');
      if (applyButton) {
        applyButton.addEventListener('click', () => {
          this.applyFilters();
        });
      }

    } catch (error) {
      console.error('Failed to populate filters:', error);
      Utils.showToast('Failed to load filter options', 'error');
    }
  }

  async populateOrigNodeFilter() {
    try {
      const nodes = await window.apiManager.getDistinctOrigNodes();
      this.populateSelect('origNode', nodes, 'All Origin Nodes');
    } catch (err) {
      console.error('Failed to load origin nodes', err);
    }
  }

  async populateDestNodeFilter() {
    try {
      const nodes = await window.apiManager.getDistinctDestNodes();
      this.populateSelect('destNode', nodes, 'All Destination Nodes');
    } catch (err) {
      console.error('Failed to load destination nodes', err);
    }
  }


  async populateShipperFilter() {
    try {
      const shippers = await window.apiManager.getDistinctShippers(); // new API
      const select = document.getElementById('shipper');
      if (!select) return;

      shippers.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; // or s.id if you prefer
        opt.textContent = s;
        select.appendChild(opt);
      });
    } catch (error) {
      console.error('Failed to load shippers:', error);
      Utils.showToast('Failed to load shipper filter', 'error');
    }
  }


  populateSelect(selectId, options, defaultText) {
  const select = document.getElementById(selectId);
  if (!select) return;

  // If TomSelect exists → update via API
  if (select.tomselect) {
    const ts = select.tomselect;
    ts.clearOptions();

    options.forEach(opt => {
      ts.addOption({ value: opt, text: opt });
    });

    ts.refreshOptions(false);
    return;
  }

  // Fallback (non-TomSelect)
  select.innerHTML = `<option value="">${defaultText}</option>`;
  options.forEach(option => {
    const optionElement = document.createElement('option');
    optionElement.value = option;
    optionElement.textContent = option;
    select.appendChild(optionElement);
  });
}



  applySearchFilter(searchTerm) {
    if (window.tableManager) {
      window.tableManager.applySearch(searchTerm);
    }
  }

applyFilters() {
  const countryValues = Array.from(document.getElementById("country")?.tomselect?.items || []);
  const statusValues = Array.from(document.getElementById("executionStatus")?.tomselect?.items || []);
  const shipperValues = Array.from(document.getElementById("shipper")?.tomselect?.items || []);
  const origNodeValues = Array.from(document.getElementById("origNode")?.tomselect?.items || []);
  const destNodeValues = Array.from(document.getElementById("destNode")?.tomselect?.items || []);
  const shipperAccountValues = Array.from(document.getElementById("shipperAccount")?.tomselect?.items || []);

  const startDate = document.getElementById('startDate')?.value;
  const endDate = document.getElementById('endDate')?.value;

  // ✅ New email sent dropdown
  const emailSentStatus = document.getElementById('emailSentStatus')?.value;

  const isManualSourceCheckbox = document.getElementById('isManualSource');
  const manualSourceWeek = document.getElementById('manualSourceWeek')?.value;
  const searchParams = new URLSearchParams();
  const path = window.location.pathname;
  const isManualSourcedRunsPage = path.includes("/manual-sourced-runs");
  const sundayStart = manualSourceWeek ? this.toSundayISO(manualSourceWeek) : '';

  // Dropdown filters
  countryValues.forEach(c => searchParams.append("orig_country", c));
  statusValues.forEach(s => searchParams.append("vehicle_execution_status", s));
  shipperValues.forEach(s => searchParams.append("shippername", s));
  origNodeValues.forEach(n => searchParams.append("orig_node", n));
  destNodeValues.forEach(n => searchParams.append("dest_node", n));
  shipperAccountValues.forEach(a => searchParams.append("shipper_account", a));


  // Dates
  if (isManualSourcedRunsPage && sundayStart) {
    searchParams.set("manual_source_week_start", sundayStart);
  } else {
    if (startDate) searchParams.set("start_date", startDate);
    if (endDate) searchParams.set("end_date", endDate);
  }

  // ✅ Add email filter if selected
  if (emailSentStatus) searchParams.set("email_sent_confirmed_at", emailSentStatus);

  // Add manual source if checked
  if (isManualSourceCheckbox?.checked) searchParams.set("is_manual_source", "1");
  if (!isManualSourcedRunsPage && sundayStart) searchParams.set("manual_source_week_start", sundayStart);

  // No carrier/status defaults for LTL manual sourcing — user-driven filters.

  if (isManualSourcedRunsPage) {
    if (!searchParams.has("is_manual_source")) searchParams.set("is_manual_source", "1");
  }

  // Update URL & reload table
  history.replaceState(null, '', `${window.location.pathname}?${searchParams.toString()}`);
  if (window.tableManager) window.tableManager.fetchData();
  Utils.showToast("Filters applied", "success");
}


};


// Initialize filter manager
document.addEventListener('DOMContentLoaded', () => {
  window.filterManager = new FilterManager();
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    // Fetch distinct options from backend
    const [countries, statuses, shippers, origNodes, destNodes] = await Promise.all([
      fetch("/api/filters/countries").then(r => r.ok ? r.json() : []),
      fetch("/api/filters/execution-status").then(r => r.ok ? r.json() : []),
      fetch("/api/filters/shippers").then(r => r.ok ? r.json() : []),
      fetch("/api/filters/orig-nodes").then(r => r.ok ? r.json() : []),
      fetch("/api/filters/dest-nodes").then(r => r.ok ? r.json() : []),
    ]);

    // Initialize Country dropdown if exists
    const countryEl = document.getElementById("country");
    if (countryEl && !countryEl.tomselect) {
      new TomSelect("#country", {
        options: countries.map(c => ({ value: c, text: c })),
        plugins: ['remove_button'],
        persist: false,
        create: false
      });
    }

    // Initialize Origin Node dropdown
    const origNodeEl = document.getElementById("origNode");
    if (origNodeEl && !origNodeEl.tomselect) {
      new TomSelect("#origNode", {
        options: origNodes.map(n => ({ value: n, text: n })),
        plugins: ['remove_button'],
        persist: false,
        create: false
      });
    }

    // Initialize Destination Node dropdown
    const destNodeEl = document.getElementById("destNode");
    if (destNodeEl && !destNodeEl.tomselect) {
      new TomSelect("#destNode", {
        options: destNodes.map(n => ({ value: n, text: n })),
        plugins: ['remove_button'],
        persist: false,
        create: false
      });
    }


    // Initialize Execution Status dropdown if exists
    const statusEl = document.getElementById("executionStatus");
    if (statusEl && !statusEl.tomselect) {
      new TomSelect("#executionStatus", {
        options: statuses.map(s => ({ value: s, text: s })),
        plugins: ['remove_button'],
        persist: false,
        create: false
      });
    }

    // Initialize Shipper dropdown if exists
    const shipperEl = document.getElementById("shipper");
    const shipperContainer = document.getElementById("shipperContainer");
    if (shipperEl && shippers.length > 0) {
      if (shipperContainer) shipperContainer.classList.remove("hidden");
      if (!shipperEl.tomselect) {
        new TomSelect("#shipper", {
          options: shippers.map(s => ({ value: s, text: s })),
          plugins: ['remove_button'],
          persist: false,
          create: false
        });
      }
    }

  } catch (err) {
    console.error("Failed to initialize dropdowns:", err);
    Utils.showToast("Failed to load filter options", "error");
  }
});


document.getElementById("clearFilter").addEventListener("click", () => {
  const tsElements = ["country", "executionStatus", "shipper", "origNode", "destNode", "shipperAccount"];
  
  // Clear all TomSelect dropdowns
  tsElements.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.tomselect) {
      el.tomselect.clear();
    }
  });

  // Only reset dates if they exist on this page
  const startDateEl = document.getElementById('startDate');
  const endDateEl = document.getElementById('endDate');
  const manualSourceWeekEl = document.getElementById('manualSourceWeek');
  if (startDateEl) startDateEl.value = '';
  if (endDateEl) endDateEl.value = '';
  if (manualSourceWeekEl) manualSourceWeekEl.value = '';

  // Build params from cleared values
  const params = {};

  const path = window.location.pathname;
  if (path.includes('/manual-sourced-runs')) {
    params.is_manual_source = 1;
  }

  // Update URL without forcing today
  Utils.updateURLParams(params);

  // Fetch data
  if (window.tableManager) window.tableManager.fetchData();

  Utils.showToast('Filters cleared', 'success');
});



