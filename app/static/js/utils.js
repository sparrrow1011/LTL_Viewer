// Utility Functions
class Utils {
  // Show loading overlay
  static showLoading() {
    const loading = document.getElementById('loading');
    if (loading) {
      loading.classList.remove('hidden');
    }
  }

  // Hide loading overlay
  static hideLoading() {
    const loading = document.getElementById('loading');
    if (loading) {
      loading.classList.add('hidden');
    }
  }

  // Show toast notification
  static showToast(message, type = 'info', duration = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const icons = {
      success: 'fa-check-circle text-green-500',
      error: 'fa-exclamation-circle text-red-500',
      warning: 'fa-exclamation-triangle text-yellow-500',
      info: 'fa-info-circle text-blue-500'
    };

    const bgColors = {
      success: 'bg-green-50 dark:bg-green-900 border-green-200 dark:border-green-700',
      error: 'bg-red-50 dark:bg-red-900 border-red-200 dark:border-red-700',
      warning: 'bg-yellow-50 dark:bg-yellow-900 border-yellow-200 dark:border-yellow-700',
      info: 'bg-blue-50 dark:bg-blue-900 border-blue-200 dark:border-blue-700'
    };

    toast.className = `flex items-center p-4 rounded-lg border shadow-lg transform transition-all duration-300 translate-x-full ${bgColors[type] || bgColors.info}`;
    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info} mr-3"></i>
      <span class="text-gray-800 dark:text-gray-200 font-medium">${message}</span>
      <button class="ml-4 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
        <i class="fas fa-times"></i>
      </button>
    `;

    container.appendChild(toast);

    // Animate in
    setTimeout(() => {
      toast.classList.remove('translate-x-full');
    }, 100);

    // Auto remove
    const removeToast = () => {
      toast.classList.add('translate-x-full');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    };

    // Remove on click
    toast.querySelector('button').addEventListener('click', removeToast);

    // Auto remove after duration
    if (duration > 0) {
      setTimeout(removeToast, duration);
    }
  }

  // Format date
  static formatDate(dateString) {
    if (!dateString) return '';
    try {
      return new Date(dateString).toLocaleString();
    } catch (e) {
      return dateString;
    }
  }

  // Debounce function
  static debounce(func, wait) {
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

  // Update URL parameters
static updateURLParams(params) {
  const url = new URL(window.location);

  // Remove old keys first
  Object.keys(params).forEach(key => url.searchParams.delete(key));

  // Add new params
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      // Append each value individually to create repeated query keys
      value.forEach(v => url.searchParams.append(key, v));
    } else if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  // Update browser URL without reloading
  window.history.replaceState({}, '', url);
}

// Clear all URL parameters without reloading
static clearURLParams() {
  const url = new URL(window.location);
  url.search = '';
  window.history.replaceState({}, '', url);
}

// 2️⃣ Convert URLSearchParams into an object that keeps arrays
static getURLParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const params = {};

  for (const key of urlParams.keys()) {
    const values = urlParams.getAll(key);
    // If more than one value, keep as array; else single value
    params[key] = values.length > 1 ? values : values[0];
  }

  return params;
}



  // Connection status indicator
  static updateConnectionStatus(isConnected) {
    const status = document.getElementById('connectionStatus');
    if (!status) return;

    const indicator = status.querySelector('div');
    const text = status.querySelector('span');

    if (isConnected) {
      indicator.className = 'w-2 h-2 bg-green-500 rounded-full animate-pulse';
      text.textContent = 'Connected';
    } else {
      indicator.className = 'w-2 h-2 bg-red-500 rounded-full';
      text.textContent = 'Disconnected';
    }
  }
}

// Global utility functions
window.showToast = Utils.showToast;
window.showLoading = Utils.showLoading;
window.hideLoading = Utils.hideLoading;
