/* ===================== FIREBASE CONFIG =====================
   1) در Firebase Console یک پروژه جدید بسازید (رایگان - پلن Spark کافی است).
   2) یک اپ «وب» به پروژه اضافه کنید و مقادیر زیر را از تنظیمات پروژه کپی کنید.
   3) از منوی Build > Firestore Database یک دیتابیس بسازید (حالت production).
   4) از منوی Build > Authentication، روش ورود «Anonymous» را فعال کنید
      (برای اینکه اپ بتواند بدون سرور جداگانه، طبق قوانین امنیتی Firestore کار کند).
   5) قوانین Firestore (Rules) را از فایل firestore.rules در همین پوشه کپی و در
      Firestore Database > Rules جایگزین کنید و Publish بزنید.
   راهنمای کامل‌تر در README.md موجود است.
============================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyAG5a2CoNARQxXhVmlK9qIMSzIvSRl5Hls",
  authDomain: "negin-etebar.firebaseapp.com",
  databaseURL: "https://negin-etebar-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "negin-etebar",
  storageBucket: "negin-etebar.firebasestorage.app",
  messagingSenderId: "157770538031",
  appId: "1:157770538031:web:a9424ad3c9bebfb94cbada"
};

/* ===================== App Check (امنیت اضافه) =====================
   1) در Firebase Console بروید به Build > App Check.
   2) اپ وب خود را ثبت کنید و «reCAPTCHA v3» را به‌عنوان provider انتخاب کنید
      (یک site key در همان صفحه به شما داده می‌شود - آن را اینجا جای‌گذاری کنید).
   3) بعد از چند روز که مطمئن شدید همه با موفقیت وصل می‌شوند، در تب Firestore
      همان صفحه‌ی App Check، گزینه‌ی «Enforce» را فعال کنید تا هر درخواستی که
      از خارج همین اپ وب بیاید (مثلاً با کلید عمومی apiKey از یک اسکریپت/بات)
      رد شود. تا وقتی Enforce را نزده‌اید، این کد فقط token اضافه می‌کند و هیچ
      محدودیتی اعمال نمی‌شود - یعنی فعال‌کردنش خطری برای کاربران فعلی ندارد.
   ===================================================================== */
const RECAPTCHA_V3_SITE_KEY = "6LfHSkstAAAAANirfMPgiYOjZdZ2AqeRjqFKiHAC";
