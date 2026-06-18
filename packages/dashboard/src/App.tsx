import React from "react";
import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Overview } from "./pages/Overview";
import { Accounts } from "./pages/Accounts";
import { Jobs } from "./pages/Jobs";
import { Proxies } from "./pages/Proxies";
import { Logs } from "./pages/Logs";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/proxies" element={<Proxies />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
