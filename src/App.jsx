import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import AuthProvider from "./auth/AuthProvider";
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
import NotFound from "./pages/NotFound";

/**
 * Route table.
 *
 * Public and private routes are separated by guards rather than by convention:
 * `ProtectedRoute` keeps a signed-out visitor off screens that can only render
 * errors, and `PublicOnlyRoute` keeps a signed-in farmer off the register and
 * login screens. Neither is a security control — every private endpoint is
 * enforced server-side (architecture §18.7).
 */
function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<PublicOnlyRoute />}>
              <Route path="/" element={<Registration />} />
              <Route path="/login" element={<Login />} />
              <Route path="/verify-otp" element={<OTPVerification />} />
            </Route>

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

            <Route path="/register" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
