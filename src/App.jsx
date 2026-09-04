import { BrowserRouter, Routes, Route } from "react-router-dom";

import AuthProvider from "./auth/AuthProvider";
import { OFFICER } from "./auth/roles";
import ErrorBoundary from "./components/ErrorBoundary";
import { ProtectedRoute, PublicOnlyRoute } from "./components/ProtectedRoute";

import Registration from "./pages/farmer/Registration";
import OTPVerification from "./pages/farmer/OTPVerification";
import Login from "./pages/farmer/Login";
import Dashboard from "./pages/farmer/Dashboard";
import BookSlot from "./pages/farmer/BookSlot";
import BookingConfirmation from "./pages/farmer/BookingConfirmation";
import MyBooking from "./pages/farmer/MyBooking";
import QueueStatus from "./pages/farmer/QueueStatus";
import Procurement from "./pages/farmer/Procurement";
import Payment from "./pages/farmer/Payment";
import Notifications from "./pages/farmer/Notifications";
import Profile from "./pages/farmer/Profile";

import OfficerLogin from "./pages/officer/OfficerLogin";
import OfficerRegistration from "./pages/officer/OfficerRegistration";
import OfficerPortal from "./officer/OfficerPortal";

import LanguageSelect from "./pages/LanguageSelect";
import PortalSelect from "./pages/PortalSelect";
import NotFound from "./pages/NotFound";

/**
 * Route table for both portals.
 *
 * Guards separate public from private, and farmer from officer. Neither is a
 * security control — the server enforces every endpoint, and an officer
 * calling a farmer route gets a 403 regardless (architecture §18.7). They
 * exist so nobody lands on a screen that can only render errors.
 *
 * `/verify-otp` is deliberately shared: one OTP screen completes farmer
 * registration, farmer login and staff two-factor alike, then routes by the
 * role `GET /me` reports.
 */
function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/*
              Entry flow, in order: choose a language, choose a portal, then the
              sign-in screen for that portal. Registration moved off "/" to
              "/register" so the language choice is genuinely first — a farmer
              who cannot read the interface cannot fill in a form in it.
            */}
            <Route element={<PublicOnlyRoute />}>
              <Route path="/" element={<LanguageSelect />} />
              <Route path="/portal" element={<PortalSelect />} />
              <Route path="/register" element={<Registration />} />
              <Route path="/login" element={<Login />} />
              <Route path="/staff-login" element={<OfficerLogin />} />
              <Route path="/staff-register" element={<OfficerRegistration />} />
              <Route path="/verify-otp" element={<OTPVerification />} />
            </Route>

            {/* Farmer portal */}
            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/book-slot" element={<BookSlot />} />
              <Route path="/booking-confirmation" element={<BookingConfirmation />} />
              <Route path="/my-booking" element={<MyBooking />} />
              <Route path="/queue" element={<QueueStatus />} />
              <Route path="/procurement" element={<Procurement />} />
              <Route path="/payment" element={<Payment />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/profile" element={<Profile />} />
            </Route>

            {/* Officer portal */}
            <Route element={<ProtectedRoute role={OFFICER} />}>
              <Route path="/officer/*" element={<OfficerPortal />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
