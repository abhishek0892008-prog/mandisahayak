import { NavLink } from "react-router-dom";

export const Navbar = () => {
  const navItems = [
    { label: "Dashboard", to: "/setup" },
    { label: "Queue", to: "/queue" },
    { label: "Weighment", to: "/weighment" },
    { label: "Payments", to: "/payments" },
    { label: "Reports", to: "/reports" },
  ];

  const getNavClass = ({ isActive }) =>
    [
      "flex shrink-0 items-center justify-center rounded-full border px-3 py-2 text-sm font-semibold transition sm:px-4",
      isActive
        ? "border-white/50 bg-white text-emerald-900 shadow-lg shadow-emerald-950/10"
        : "border-white/25 bg-white/10 text-white hover:bg-white/20",
    ].join(" ");

  return (
    <header className="rounded-[20px] border border-white/15 bg-transparent p-0 shadow-none backdrop-blur-none sm:p-0">
      <div className="mb-4">
        <p className="text-lg font-black uppercase tracking-[0.18em] text-white">
          Faramqueue
        </p>
      </div>

      <nav className="flex flex-nowrap gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
        {navItems.map(({ label, to }) => (
          <NavLink key={label} to={to} className={getNavClass}>
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
};
