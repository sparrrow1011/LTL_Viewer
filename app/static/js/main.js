// Main Application Controller
class AppController {
  constructor() {
    this.init();
  }

  init() {
    this.setupGlobalEventListeners();
    this.setupDatabaseActions();
    this.initializePageSpecificFeatures();
  }

  setupGlobalEventListeners() {
    // Global search functionality
    const globalSearch = document.getElementById('globalSearch');
    if (globalSearch) {
      const debouncedSearch = Utils.debounce((value) => {
        if (window.tableManager) {
          window.tableManager.applySearch(value);
        }
      }, 300);

      globalSearch.addEventListener('input', (e) => {
        debouncedSearch(e.target.value);
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + K for search focus
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.getElementById('globalSearch');
        if (searchInput) {
          searchInput.focus();
        }
      }

      // Escape to clear search
      if (e.key === 'Escape') {
        const searchInput = document.getElementById('globalSearch');
        if (searchInput && searchInput === document.activeElement) {
          searchInput.value = '';
          searchInput.blur();
          if (window.tableManager) {
            window.tableManager.applySearch('');
          }
        }
      }
    });

    // Handle online/offline status
    window.addEventListener('online', () => {
      Utils.updateConnectionStatus(true);
      // Refresh data when coming back online
      if (window.tableManager) {
        window.tableManager.fetchData();
      }
    });

    window.addEventListener('offline', () => {
      Utils.updateConnectionStatus(false);
    });
  }

  setupDatabaseActions() {
    // Update Database button
    const updateDBBtn = document.getElementById('updateDB');
    if (updateDBBtn) {
      updateDBBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to update the database? This may take a few minutes.')) {
          return;
        }

        try {
          updateDBBtn.disabled = true;
          updateDBBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Updating...';
          
          await window.apiManager.updateDatabase();
          
          Utils.showToast('Database updated successfully!', 'success');
          
          // Refresh data after update
          if (window.tableManager) {
            window.tableManager.fetchData();
          }
          
        } catch (error) {
          console.error('Database update failed:', error);
          Utils.showToast('Database update failed', 'error');
        } finally {
          updateDBBtn.disabled = false;
          updateDBBtn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i>Update DB';
        }
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById('refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (window.tableManager) {
          window.tableManager.fetchData();
        }
        Utils.showToast('Data refreshed', 'success');
      });
    }
  }

  initializePageSpecificFeatures() {
    const path = window.location.pathname;
    
    // Load dashboard stats for home page
    if (path === '/' || path === '/index') {
      this.loadDashboardStats();
    }
  }

 async  loadDashboardStats() {
  try {
    const stats = await window.apiManager.getDashboardStats();

    if (!stats || typeof stats !== "object") return;

    // Update values automatically
    Object.entries(stats).forEach(([key, value]) => {
      const el = document.getElementById(key);
      if (el) el.textContent = value ?? "0";
    });

    // Last updated special handling
    const lastUpdatedEl = document.getElementById("lastUpdated");
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = stats.lastUpdated 
        ? new Date(stats.lastUpdated).toLocaleString()
        : "Never";
    }

  } catch (error) {
    console.error("Failed to load dashboard stats:", error);
  }
}

}

// Global functions that need to be available
window.populateFilters = async function() {
  if (window.filterManager) {
    await window.filterManager.populateDropdownFilters();
  }
};

window.fetchData = function() {
  if (window.tableManager) {
    window.tableManager.fetchData(); // it already pulls from window.location.search
  }
};


window.updateSelectedCount = function() {
  const selectedCount = document.querySelectorAll('#tbody input[type=checkbox]:checked').length;
  const countElementMail = document.getElementById('selectedCountMail');
  const sendButtonMail = document.getElementById('sendSelectedMail');
  const countElementEML = document.getElementById('selectedCountEML');
  const sendButtonEML = document.getElementById('sendSelectedEML')

  if (countElementMail) {
    countElementMail.textContent = selectedCount;
  }
  if (sendButtonMail) {
    sendButtonMail.disabled = selectedCount === 0 || selectedCount > 3; // Disable if more than 3 selected
  }
  if (countElementEML) {
    countElementEML.textContent = selectedCount;
  }
  // if (sendButtonEML) {
  //   sendButtonEML.disabled = selectedCount < 4;
  // }

};

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  window.appController = new AppController();
  
  // Show welcome message
  setTimeout(() => {
    Utils.showToast('Welcome to CST Dashboard', 'info', 3000);
  }, 1000);
});

// Check session status
async function checkSession() {
    try {
        const response = await fetch("/api/auth/status");
        const data = await response.json();

        const logoutBtn = document.getElementById("logoutBtn");
        const usernameEl = document.getElementById("username");
        const roleEl = document.getElementById("role");

        if (!logoutBtn || !usernameEl || !roleEl) return;

        if (data.authenticated) {
            console.log("User logged in:", data.user, "Role:", data.role);
            logoutBtn.style.display = "block";
            usernameEl.textContent = data.user;
            roleEl.textContent = data.role;
        } else {
            console.log("User not logged in");
            logoutBtn.style.display = "none";
            usernameEl.textContent = "Guest";
            roleEl.textContent = "";
        }
    } catch (err) {
        console.error("Error checking session:", err);
    }
}

// Logout function
async function logout() {
    try {
        const response = await fetch("/api/auth/logout", { method: "POST" });
        const data = await response.json();
        if (data.success) {
            console.log("Logged out successfully");
            // Redirect to login page
            window.location.href = "/login";
        }
    } catch (err) {
        console.error("Error logging out:", err);
    }
}

// Attach logout button
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
    logoutBtn.addEventListener("click", logout);
}

// Initial check on page load
checkSession();

