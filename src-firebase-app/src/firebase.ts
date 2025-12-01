// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCYbqMKKP2gAFYCmt8WWI03v1-XEU68Tm0",
    authDomain: "hypercool-fe1fa.firebaseapp.com",
    projectId: "hypercool-fe1fa",
    storageBucket: "hypercool-fe1fa.firebasestorage.app",
    messagingSenderId: "33621671234",
    appId: "1:33621671234:web:48ea6b73dd3768ddc71cdb",
    measurementId: "G-0QXFC8CEJT"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, analytics, auth, db };
