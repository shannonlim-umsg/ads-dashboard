// Firebase Realtime Database configuration for live shared dashboard edits.
// Replace every PASTE_* value with your Firebase Web App config.
// Keep this file public-safe: Firebase web config is not a secret.
const firebaseConfig = {
    apiKey: "AIzaSyDHULxuGdFxBGv3CSS_OhRi_qjI4z6BCtk",
    authDomain: "umsg-ads-dashboard.firebaseapp.com",
    databaseURL: "https://umsg-ads-dashboard-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "umsg-ads-dashboard",
    storageBucket: "umsg-ads-dashboard.firebasestorage.app",
    messagingSenderId: "58232586723",
    appId: "1:58232586723:web:26e208214d12261360e0d6",
    measurementId: "G-EL5X9DHMNS"
};

// Change this path if you want separate dashboards/environments.
window.DASHBOARD_LIVE_PATH = "dashboards/umg-meta-dashboard/state";
