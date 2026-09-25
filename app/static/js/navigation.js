// Navigation and Sidebar Management
class NavigationManager {
  constructor() {
    this.sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    this.init();
  }

  init() {
    this.applySidebarState();
    this.setupEventListeners();
    this.setupKeyboardShortcuts();
  }

  setupEventListeners() {
    // Desktop sidebar toggle
    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => this.toggleSidebar());
    }

    // Mobile sidebar toggle
    const mobileSidebarToggle = document.getElementById('mobileSidebarToggle');
    if (mobileSidebarToggle) {
      mobileSidebarToggle.addEventListener('click', () => this.toggleMobileSidebar());
    }

    // Mobile overlay
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    if (sidebarOverlay) {
      sidebarOverlay.addEventListener('click', () => this.closeMobileSidebar());
    }

    // Global search
    const globalSearch = document.getElementById('globalSearch');
    if (globalSearch) {
      globalSearch.addEventListener('input', this.debounce((e) => {
        this.performGlobalSearch(e.target.value);
      }, 300));
    }

    // Date range application
    const applyDateRange = document.getElementById('applyDateRange');
    if (applyDateRange) {
      applyDateRange.addEventListener('click', () => this.applyDateRange());
    }

    // Quick action buttons
    const updateDB = document.getElementById('updateDB');
    const refresh = document.getElementById('refresh');
    
    if (updateDB) {
      updateDB.addEventListener('click', () => this.updateDatabase());
    }
    
    if (refresh) {
      refresh.addEventListener('click', () => this.refreshData());
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + K for search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.getElementById('globalSearch');
        if (searchInput) {
          searchInput.focus();
        }
      }

      // Ctrl/Cmd + B for sidebar toggle
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        this.toggleSidebar();
      }

      // Escape to clear search
      if (e.key === 'Escape') {
        const searchInput = document.getElementById('globalSearch');
        if (searchInput && searchInput.value) {
          searchInput.value = '';
          this.performGlobalSearch('');
        }
      }
    });
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.applySidebarState();
    localStorage.setItem('sidebarCollapsed', this.sidebarCollapsed.toString());
  }

  applySidebarState() {
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    
    if (!sidebar) return;

    if (this.sidebarCollapsed) {
      sidebar.classList.add('w-16');
      sidebar.classList.remove('w-64');
      
      // Hide text elements
      document.querySelectorAll('.sidebar-text').forEach(el => {
        el.style.display = 'none';
      });
      
      // Update toggle icon
      if (sidebarToggle) {
        sidebarToggle.querySelector('i').className = 'fas fa-chevron-right text-gray-300 dark:text-gray-400';
      }
      
      // Hide workspace info
      const workspaceInfo = document.getElementById('workspace-info');
      if (workspaceInfo) {
        workspaceInfo.style.display = 'none';
      }
    } else {
      sidebar.classList.add('w-64');
      sidebar.classList.remove('w-16');
      
      // Show text elements
      document.querySelectorAll('.sidebar-text').forEach(el => {
        el.style.display = '';
      });
      
      // Update toggle icon
      if (sidebarToggle) {
        sidebarToggle.querySelector('i').className = 'fas fa-chevron-left text-gray-300 dark:text-gray-400';
      }
      
      // Show workspace info
      const workspaceInfo = document.getElementById('workspace-info');
      if (workspaceInfo) {
        workspaceInfo.style.display = '';
      }
    }
  }

  toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    
    if (sidebar && overlay) {
      sidebar.classList.toggle('-translate-x-full');
      overlay.classList.toggle('hidden');
    }
  }

  closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    
    if (sidebar && overlay) {
      sidebar.classList.add('-translate-x-full');
      overlay.classList.add('hidden');
    }
  }

  performGlobalSearch(query) {
    // Implement global search functionality
    console.log('Searching for:', query);
    
    // You can implement this to search across different data sources
    if (typeof applyFilter === 'function') {
      // If on a page with table data, apply search to table
      const searchInput = document.getElementById('q');
      if (searchInput) {
        searchInput.value = query;
        applyFilter();
      }
    }
  }

  applyDateRange() {
    const startDate = document.getElementById('startDate')?.value;
    const endDate = document.getElementById('endDate')?.value;

    if (!startDate || !endDate) {
      Utils.showToast('Please select both start and end dates', 'warning');
      return;
    }

    // Update URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('start_date', startDate);
    urlParams.set('end_date', endDate);
    
    window.history.replaceState({}, '', '?' + urlParams.toString());
    
    // Refresh data if function exists
    if (typeof fetchData === 'function') {
      fetchData();
    }
    
    Utils.showToast('Date range applied', 'success');
  }

  async updateDatabase() {
    if (!confirm('Are you sure you want to update the database? This may take a few minutes.')) {
      return;
    }

    try {
      Utils.showLoading();
      const response = await fetch('/api/update-db', { method: 'POST' });
      const result = await response.json();

      if (result.success) {
        Utils.showToast('Database updated successfully!', 'success');
        
        // Refresh current page data
        if (typeof fetchData === 'function') {
          fetchData();
        }
      } else {
        Utils.showToast(result.message || 'Database update failed', 'error');
      }
    } catch (error) {
      console.error('Database update error:', error);
      Utils.showToast('Error updating database', 'error');
    } finally {
      Utils.hideLoading();
    }
  }

  refreshData() {
    if (typeof fetchData === 'function') {
      fetchData();
      Utils.showToast('Data refreshed', 'success');
    } else {
      window.location.reload();
    }
  }

  // Utility function for debouncing
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

// Initialize navigation manager
document.addEventListener('DOMContentLoaded', () => {
  window.navigationManager = new NavigationManager();
});

// Export for global use
window.NavigationManager = NavigationManager;