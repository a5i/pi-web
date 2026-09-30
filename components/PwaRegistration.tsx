"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      // A production worker can outlive a switch to next dev on the same origin.
      // Its cache-first handler otherwise keeps serving old Turbopack chunks.
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        const owned = registrations.filter((registration) => {
          const worker = registration.active ?? registration.waiting ?? registration.installing;
          if (!worker) return false;
          const url = new URL(worker.scriptURL);
          return url.origin === window.location.origin && url.pathname === "/sw.js";
        });
        if (owned.length === 0) return;
        await Promise.all(owned.map((registration) => registration.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("pi-web-")).map((key) => caches.delete(key)));
        window.location.reload();
      }).catch((error: unknown) => {
        console.error("Failed to remove the Pi Web development service worker:", error);
      });
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the Pi Web service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
