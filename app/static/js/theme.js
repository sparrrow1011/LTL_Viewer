// Theme Management
class ThemeManager {
  constructor() {
    this.theme = localStorage.getItem('theme') || 'light';
    this.init();
  }

  init() {
    this.applyTheme();
    this.setupToggle();
  }

  applyTheme() {
    const html = document.documentElement;
    const themeIcon = document.getElementById('themeIcon');
    
    if (this.theme === 'dark') {
      html.classList.add('dark');
      if (themeIcon) {
        themeIcon.className = 'fas fa-sun text-gray-300';
      }
    } else {
      html.classList.remove('dark');
      if (themeIcon) {
        themeIcon.className = 'fas fa-moon text-gray-600';
      }
    }
    
    localStorage.setItem('theme', this.theme);
  }

  toggle() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    this.applyTheme();
    
    // Dispatch custom event for other components
    window.dispatchEvent(new CustomEvent('themeChanged', { 
      detail: { theme: this.theme } 
    }));
  }

  setupToggle() {
    const toggleButton = document.getElementById('themeToggle');
    if (toggleButton) {
      toggleButton.addEventListener('click', () => this.toggle());
    }
  }
}

// Initialize theme manager
document.addEventListener('DOMContentLoaded', () => {
  window.themeManager = new ThemeManager();
});