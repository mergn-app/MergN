import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "./index.css";
import "./i18n";
import { router } from "./router";
import { initAnalytics } from "./analytics";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

initAnalytics();

const container = document.getElementById("root");

if (container) {
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
