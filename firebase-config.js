// Firebase Realtime Database configuration for live shared dashboard edits.
// Firebase Web App config is public-safe, but secure your database with rules/auth for production.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDHULxuGdFxBGv3CSS_OhRi_qjI4z6BCtk",
  authDomain: "umsg-ads-dashboard.firebaseapp.com",
  databaseURL: "https://umsg-ads-dashboard-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "umsg-ads-dashboard",
  storageBucket: "umsg-ads-dashboard.firebasestorage.app",
  messagingSenderId: "58232586723",
  appId: "1:58232586723:web:26e208214d12261360e0d6",
  measurementId: "G-EL5X9DHMNS"
};

// Change this if you want multiple separate dashboards in one Firebase database.
window.DASHBOARD_LIVE_PATH = "dashboards/umg-meta-dashboard/state";
