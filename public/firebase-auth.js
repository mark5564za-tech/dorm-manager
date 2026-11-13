import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBq48Razwk20LWDEbwLTnmBTPb7fXIS3P0",
  authDomain: "dorm-manager-43352.firebaseapp.com",
  projectId: "dorm-manager-43352",
  appId: "1:1090246094698:web:b92d6cb78bf96fdae77f13",
  messagingSenderId: "1090246094698"
};
const ADMIN_UIDS = new Set(["SKhyOMyeuzXZz8QMZtENFnsm0WJ2", "x8Ncthxrc1aXgBSXU6iHRzPafLx2"]);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

window.firebaseAuthLogin = async (email, password) => {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  if (!ADMIN_UIDS.has(credential.user.uid)) {
    await signOut(auth);
    throw new Error("บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
  }
  return credential.user;
};
window.firebaseAuthToken = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error("กรุณาเข้าสู่ระบบใหม่");
  if (!ADMIN_UIDS.has(user.uid)) {
    await signOut(auth);
    throw new Error("บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
  }
  return user.getIdToken();
};
window.firebaseAuthLogout = () => signOut(auth);
onAuthStateChanged(auth, user => {
  window.firebaseAuthCurrentUser = user && ADMIN_UIDS.has(user.uid) ? user : null;
  if (user && !ADMIN_UIDS.has(user.uid)) signOut(auth);
  window.dispatchEvent(new Event("firebase-auth-ready"));
});
