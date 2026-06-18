import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Users, Briefcase, Globe, Activity, Settings } from "lucide-react";

const NAV = [
  { to: "/", label: "Overview",  icon: LayoutDashboard },
  { to: "/accounts", label: "Accounts", icon: Users },
  { to: "/jobs",  label: "Jobs",     icon: Briefcase },
  { to: "/proxies", label: "Proxies",  icon: Globe },
  { to: "/logs",  label: "Logs",     icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-800">
          <span className="text-lg font-bold text-brand-500">🎯 CA-Bot</span>
          <p className="text-xs text-gray-500 mt-0.5">Job Sniper v2</p>
        </div>
        <nav className="flex-1 py-4 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800/60"
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-gray-800">
          <p className="text-xs text-gray-600">v2.0.0</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-gray-950">
        <Outlet />
      </main>
    </div>
  );
}
