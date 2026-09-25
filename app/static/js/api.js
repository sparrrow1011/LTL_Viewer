// API Management
class ApiManager {
  constructor() {
    this.baseURL = '/api';
    this.setupInterceptors();
  }

  setupInterceptors() {
    // Monitor connection status
    window.addEventListener('online', () => {
      Utils.updateConnectionStatus(true);
      Utils.showToast('Connection restored', 'success');
    });

    window.addEventListener('offline', () => {
      Utils.updateConnectionStatus(false);
      Utils.showToast('Connection lost', 'error');
    });
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    };

    try {
      const response = await fetch(url, config);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      
      return await response.text();
    } catch (error) {
      console.error(`API Error (${endpoint}):`, error);
      Utils.showToast(`API Error: ${error.message}`, 'error');
      throw error;
    }
  }

  // Get distinct countries
  async getDistinctCountries() {
    return this.request('/distinct/countries');
  }

  // Get distinct execution statuses
  async getDistinctStatuses() {
    return this.request('/distinct/execution-status');
  }

  
  // Get distinct shipper
  async getDistinctShippers() {
    return this.request('/distinct/shipper');
  }

  // Get distinct origin nodes
  async getDistinctOrigNodes() {
    return this.request('/distinct/orig-nodes');
  }

  // Get distinct destination nodes
  async getDistinctDestNodes() {
    return this.request('/distinct/dest-nodes');
  }


  // Get table data with filters
async getTableData(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(v => searchParams.append(key, v));
    } else {
      searchParams.append(key, value);
    }
  });

  let endpoint = `/data?${searchParams.toString()}`;
  if (window.currentPage === 'auditing_uncovered') {
    endpoint = `/auditing/uncovered-orders?${searchParams.toString()}`;
  } else if (window.currentPage === 'auditing_misaligned') {
    endpoint = `/auditing/misaligned?${searchParams.toString()}`;
  } else if (window.currentPage === 'scheduling_tracker') {
    endpoint = `/scheduling/data?${searchParams.toString()}`;
  } else if (window.currentPage === 'driver_details') {
    endpoint = `/driver-details/data?${searchParams.toString()}`;
  } else if (window.currentPage === 'cfet') {
    endpoint = `/cfet/data?${searchParams.toString()}`;
  }

  return this.request(endpoint);
}

  // Update database
  async updateDatabase() {
    return this.request('/update-db', { method: 'POST' });
  }

  // Get dashboard stats
  async getDashboardStats() {
    return this.request('/stats/today');
  }

  async  runScrapper() {
    try {
    const response = await fetch('/api/run-scrapper', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return response.json();
  } catch (error) {
    console.error('Scrapper request failed:', error);
    throw error;
  }
}
}

// Initialize API manager
window.apiManager = new ApiManager();
