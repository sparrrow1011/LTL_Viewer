window.TableTools = {
  addValidateButton(buttonId = 'validateBtn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return console.warn(`[TableTools] No button found with id '${buttonId}'`);
    btn.addEventListener('click', this.validate);
  },

  addValidateAddressButton(buttonId = 'validateAddressBtn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return console.warn(`[TableTools] No button found with id '${buttonId}'`);
    btn.addEventListener('click', this.validateAddress);
  },
  addValidateDriverButton(buttonId = 'validateDriverBtn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return console.warn(`[TableTools] No button found with id '${buttonId}'`);
    btn.addEventListener('click', this.validateDriver);
  },

  addValidateUPButton(buttonId = 'validateUPBtn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return console.warn(`[TableTools] No button found with id '${buttonId}'`);
    btn.addEventListener('click', this.validateUP);
  },

  addCstUpdateButton(buttonId = 'updateCstBtn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return console.warn(`[TableTools] No button found with id '${buttonId}'`);
    btn.addEventListener('click', this.update_cst);
  },

  addSendDetailsButton(buttonId = 'sendHcDetailsBtn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return console.warn(`[TableTools] No button found with id '${buttonId}'`);
    btn.addEventListener('click', this.send_hc_details);
  },

  validateAddress() {
    Utils.showLoading();
    console.log("Running Address validation…");
    if (!window.tableManager || !window.tableManager.state.filtered.length) {
      alert('No rows to validate');
      Utils.hideLoading();
      return;
    }

    const selectedVrids = Array.from(document.querySelectorAll('#tbody input.row-select:checked'))
      .map(cb => cb.dataset.vrid)
      .filter(v => v !== undefined && v !== null && v !== '');

    const rows = window.tableManager.state.filtered;
    const vridList = selectedVrids.length
      ? selectedVrids
      : rows.map(row => row['vrid']).filter(v => v !== undefined && v !== null);

    if (!vridList.length) {
      alert('No VRID column found in the data');
      Utils.hideLoading();
      return;
    }

    console.log(`Found ${vridList.length} VRIDs`);
    console.table(vridList.slice(0, 10)); // preview

    const csvContent = ['vrid', ...vridList.map(v => `"${v.toString().replace(/"/g, '""')}"`)].join('\n');
    if (window.pywebview && window.pywebview.api) {
      const filename = `vrid_address_validation_${new Date().toISOString().split('T')[0]}.csv`;
      window.pywebview.api.validate_address_data(csvContent)
        .then(result => {
          window.tableManager.fetchData(); // refresh data after validation
          Utils.showToast('✅ Address Validation completed successfully, Please refresh before proceeding', 'success');
          console.log("Backend result:", result);
        })
        .catch(err => {
          Utils.showToast(`❌ Address Validation failed: ${err}`, 'error');
          console.error(err);
        })
      .finally(() => {
          Utils.hideLoading();
        });
    } else {
      alert('PyWebView API not available');
      Utils.hideLoading();
    }
  },

  validateDriver() {
    Utils.showLoading();
    console.log("Running Driver validation...");
    if (!window.tableManager || !window.tableManager.state.filtered.length) {
      alert('No rows to validate');
      Utils.hideLoading();
      return;
    }

    const selectedVrids = Array.from(document.querySelectorAll('#tbody input.row-select:checked'))
      .map(cb => cb.dataset.vrid)
      .filter(v => v !== undefined && v !== null && v !== '');

    const rows = window.tableManager.state.filtered;
    const vridList = selectedVrids.length
      ? selectedVrids
      : rows.map(row => row['vrid']).filter(v => v !== undefined && v !== null);

    if (!vridList.length) {
      alert('No VRID column found in the data');
      Utils.hideLoading();
      return;
    }

    console.log(`Found ${vridList.length} VRIDs`);
    console.table(vridList.slice(0, 10));

    const csvContent = ['vrid', ...vridList.map(v => `"${v.toString().replace(/"/g, '""')}"`)].join('\n');
    if (window.pywebview && window.pywebview.api) {
      window.pywebview.api.validate_driver_data(csvContent)
        .then(result => {
          window.tableManager.fetchData();
          Utils.showToast('✅ Driver Validation completed successfully, Please refresh before proceeding', 'success');
          console.log("Backend result:", result);
        })
        .catch(err => {
          Utils.showToast(`❌ Driver Validation failed: ${err}`, 'error');
          console.error(err);
        })
        .finally(() => {
          Utils.hideLoading();
        });
    } else {
      alert('PyWebView API not available');
      Utils.hideLoading();
    }
  },
    

  validate() {
    Utils.showLoading();

    if (!window.tableManager || !window.tableManager.state.filtered.length) {
      alert('No rows to validate');
      Utils.hideLoading();
      return;
    }

    const rows = window.tableManager.state.filtered;
    const vridList = rows.map(row => row['vrid']).filter(v => v !== undefined && v !== null);

    if (!vridList.length) {
      alert('No VRID column found in the data');
      Utils.hideLoading();
      return;
    }

    const csvContent = ['vrid', ...vridList.map(v => `"${v.toString().replace(/"/g, '""')}"`)].join('\n');

    if (window.pywebview && window.pywebview.api) {
      const filename = `vrid_validation_${new Date().toISOString().split('T')[0]}.csv`;

      window.pywebview.api.validate_data(csvContent)
        .then(result => {
          window.tableManager.fetchData(); // refresh data after validation
          Utils.showToast('✅ Validation completed successfully, Please refresh before proceeding', 'success');
          console.log("Backend result:", result);
        })
        .catch(err => {
          Utils.showToast(`❌ Validation failed: ${err}`, 'error');
          console.error(err);
        })
        .finally(() => {
          Utils.hideLoading();
        });
    } else {
      alert('PyWebView API not available');
      Utils.hideLoading();
    }
  },

  validateUP() {
    Utils.showLoading();

    if (!window.tableManager || !window.tableManager.state.filtered.length) {
      alert('No rows to validate');
      Utils.hideLoading();
      return;
    }

    const rows = window.tableManager.state.filtered;
    const vridList = rows.map(row => row['vrid']).filter(v => v !== undefined && v !== null);

    if (!vridList.length) {
      alert('No VRID column found in the data');
      Utils.hideLoading();
      return;
    }

    const csvContent = ['vrid', ...vridList.map(v => `"${v.toString().replace(/"/g, '""')}"`)].join('\n');

    if (window.pywebview && window.pywebview.api) {
      const filename = `vrid_up_validation_${new Date().toISOString().split('T')[0]}.csv`;

      window.pywebview.api.validate_up_data(csvContent)
        .then(result => {
          window.tableManager.fetchData(); // refresh data after validation
          Utils.showToast('✅ Unified Portal Validation completed successfully, Please refresh before proceeding', 'success');
          console.log("Backend result:", result);
        })
        .catch(err => {
          Utils.showToast(`❌ Unified Portal Validation failed: ${err}`, 'error');
          console.error(err);
        })
        .finally(() => {
          Utils.hideLoading();
        });
    } else {
      alert('PyWebView API not available');
      Utils.hideLoading();
    }
  },


  update_cst() {
    Utils.showLoading();

    console.log("Running CST update…");

    window.pywebview.api.update_cst()
      .then(result => {
        window.tableManager.fetchData(); // refresh data after update
        Utils.showToast('✅ CST update completed successfully', 'success');
        console.log("Backend result:", result);
      })
      .catch(err => {
        Utils.showToast(`❌ CST update failed: ${err}`, 'error');
        console.error(err);
      })
      .finally(() => {
        Utils.hideLoading();
      });
  },
  

  send_hc_details() {
    Utils.showLoading();
    console.log("Sending HC details to Slack…");
    window.pywebview.api.send_hc_details_to_slack()
      .then(result => {
        window.tableManager.fetchData(); // refresh data after sending HC details
        Utils.showToast('✅ HC details sent to Slack successfully', 'success');
        console.log("Backend result:", result);
      })
      .catch(err => {
        Utils.showToast(`❌ Sending HC details failed: ${err}`, 'error');
        console.error(err);
      })
      .finally(() => {
        Utils.hideLoading();
      }); 
  }
};




window.SchedulerControls = {
   isRunning: false,

  init() {
    const btn = document.getElementById('schedulerBtn');
    if (!btn) return;

    btn.addEventListener('click', () => this.toggle(btn));

    // Check current status from backend
    this.checkStatus(btn);
  },

  async checkStatus(btn) {
    if (!window.pywebview || !window.pywebview.api) return;

    try {
      const running = await window.pywebview.api.is_scheduler_running();
      this.isRunning = running;
      this.setRunningState(btn, running);
      console.log(`Scheduler state: ${running ? 'Running' : 'Stopped'}`);
    } catch (err) {
      console.warn("Could not check scheduler status:", err);
    }
  },

  async toggle(btn) {
    if (!window.pywebview || !window.pywebview.api) {
      alert('PyWebView API not available');
      return;
    }

    Utils.showLoading();

    try {
      if (!this.isRunning) {
        // Start scheduler
        const result = await window.pywebview.api.start_scheduler();
        console.log(result);
        Utils.showToast('✅ Scheduler started successfully', 'success');
        this.setRunningState(btn, true);
      } else {
        // Stop scheduler
        const result = await window.pywebview.api.stop_scheduler();
        console.log(result);
        Utils.showToast('🛑 Scheduler stopped', 'info');
        this.setRunningState(btn, false);
      }
    } catch (err) {
      Utils.showToast(`❌ Operation failed: ${err}`, 'error');
      console.error(err);
    }

    Utils.hideLoading();
  },

  setRunningState(btn, running) {
    this.isRunning = running;

    if (running) {
      btn.classList.remove('bg-green-600', 'hover:bg-green-700');
      btn.classList.add('bg-yellow-600', 'hover:bg-yellow-700');
      btn.innerHTML = `
        <i class="fas fa-spinner fa-spin"></i>
        <span>Running... (Click to Stop)</span>
      `;
    } else {
      btn.classList.remove('bg-yellow-600', 'hover:bg-yellow-700');
      btn.classList.add('bg-green-600', 'hover:bg-green-700');
      btn.innerHTML = `
        <i class="fas fa-play"></i>
        <span>Start Scheduler</span>
      `;
    }
  }
};


// ===============================
// Sweeper Scheduler Controls
// ===============================
window.SweeperSchedulerControls = {
  isRunning: false,

  init() {
    const btn = document.getElementById('schedulerSweeperBtn');
    if (!btn) return;

    btn.addEventListener('click', () => this.toggle(btn));

    // Initial backend status check
    this.checkStatus(btn);
  },

  async checkStatus(btn) {
    if (!window.pywebview || !window.pywebview.api) return;

    try {
      const running = await window.pywebview.api.is_scheduler_running_sweeper();
      this.isRunning = running;
      this.setRunningState(btn, running);
      console.log(`Sweeper Scheduler state: ${running ? 'Running' : 'Stopped'}`);
    } catch (err) {
      console.warn("Could not check sweeper scheduler status:", err);
    }
  },

  async toggle(btn) {
    if (!window.pywebview || !window.pywebview.api) {
      alert('PyWebView API not available');
      return;
    }

    Utils.showLoading();

    try {
      if (!this.isRunning) {
        const result = await window.pywebview.api.start_paragon_scheduler();
        console.log(result);
        Utils.showToast('🧹 Sweeper Scheduler started', 'success');
        this.setRunningState(btn, true);
      } else {
        const result = await window.pywebview.api.stop_paragon_scheduler();
        console.log(result);
        Utils.showToast('🛑 Sweeper Scheduler stopped', 'info');
        this.setRunningState(btn, false);
      }
    } catch (err) {
      Utils.showToast(`❌ Operation failed: ${err}`, 'error');
      console.error(err);
    }

    Utils.hideLoading();
  },

  setRunningState(btn, running) {
    this.isRunning = running;

    if (running) {
      btn.classList.remove('bg-green-600', 'hover:bg-green-700');
      btn.classList.add('bg-yellow-600', 'hover:bg-yellow-700');
      btn.innerHTML = `
        <i class="fas fa-spinner fa-spin"></i>
        <span>Sweeper Running... (Click to Stop)</span>
      `;
    } else {
      btn.classList.remove('bg-yellow-600', 'hover:bg-yellow-700');
      btn.classList.add('bg-green-600', 'hover:bg-green-700');
      btn.innerHTML = `
        <i class="fas fa-broom"></i>
        <span>Start Sweeper Scheduler</span>
      `;
    }
  }
};

