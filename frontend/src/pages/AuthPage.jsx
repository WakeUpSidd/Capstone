import React, { useState } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { IconUserPlus, IconMail, IconLock } from "../components/Icons.jsx";

export default function AuthPage({ role, onAuthSuccess }) {
  const [authMode, setAuthMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organization, setOrganization] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [showVerification, setShowVerification] = useState(false);
  const [registrationData, setRegistrationData] = useState(null);

  const { loginUser, registerUser, verifyEmail, isLoading, error, clearError } = useAuth();

  const displayRole = role.charAt(0).toUpperCase() + role.slice(1);

  const handleSubmit = async (e) => {
    e.preventDefault();
    clearError();

    if (authMode === "login") {
      const result = await loginUser({ email, password }, role);
      if (result.success) {
        onAuthSuccess(result.data);
      }
    } else {
      // Registration
      const userData = { email, password };
      if (role === 'user') {
        userData.name = name;
        userData.organization = organization;
      } else if (role === 'organisation') {
        userData.organizationName = name;
      }

      const result = await registerUser(userData, role);
      if (result.success) {
        if (role === 'user') {
          // Store registration data for verification (users only)
          setRegistrationData(userData);
          setShowVerification(true);
        } else if (role === 'organisation') {
          // Organizations don't require email OTP; log them in directly
          const loginResult = await loginUser({ email, password }, role);
          if (loginResult.success) {
            onAuthSuccess(loginResult.data);
          }
        }
      }
    }
  };

  const handleVerification = async (e) => {
    e.preventDefault();
    clearError();

    const result = await verifyEmail({
      email: registrationData.email,
      verificationCode: verificationCode.trim(),
    });

    if (result.success) {
      onAuthSuccess(result.data);
    }
  };

  const toggleMode = () => {
    setAuthMode((prev) => (prev === "login" ? "signup" : "login"));
    setName("");
    setEmail("");
    setPassword("");
    setOrganization("");
    setVerificationCode("");
    setShowVerification(false);
    setRegistrationData(null);
    clearError();
  };

  // shared container styles for both views
  const containerStyle = "flex items-center justify-center min-h-screen bg-gray-100 p-4";
  const cardStyle = "bg-white p-8 md:p-10 rounded-2xl shadow-sm w-full max-w-md fade-in border border-gray-100";

  if (showVerification && role === 'user') {
    return (
      <div className={containerStyle}>
        <div className={cardStyle}>
          <h2 className="text-3xl font-bold text-center text-black tracking-tight mb-2">
            Verify Your Email
          </h2>
          <p className="text-center text-gray-500 mb-8">
            We've sent a verification code to {registrationData?.email}
          </p>

          <form onSubmit={handleVerification} className="flex flex-col gap-5">
            <input
              type="text"
              placeholder="Enter verification code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              required
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:border-black outline-none transition-all box-border"
            />

            {error && (
              <div className="text-red-600 text-sm text-center bg-red-50 p-3 rounded-lg">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-black text-white py-3 rounded-xl font-semibold text-lg hover:bg-zinc-800 transition-all shadow-md disabled:opacity-50"
            >
              {isLoading ? "Verifying..." : "Verify Email"}
            </button>
          </form>

          <div className="flex justify-center items-center text-sm text-gray-600 mt-6">
            <button
              onClick={() => {
                setShowVerification(false);
                setRegistrationData(null);
                toggleMode();
              }}
              className="text-black font-semibold hover:underline"
            >
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={containerStyle}>
      <div className={cardStyle}>
        <h2 className="text-3xl font-bold text-center text-black tracking-tight mb-2">
          {displayRole} {authMode === "login" ? "Login" : "Sign Up"}
        </h2>
        <p className="text-center text-gray-500 mb-8">
          {authMode === "login"
            ? `Welcome back! Please login to your ${role} account.`
            : `Create your new ${role} account.`}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {authMode === "signup" && (
            <div className="relative">
              <div className="absolute inset-y-0 left-3 flex items-center text-gray-400">
                <IconUserPlus />
              </div>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="Full Name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full pl-11 pr-4 py-3 border border-gray-200 rounded-xl focus:border-black outline-none transition-all"
              />
            </div>
          )}

          {authMode === "signup" && role === "user" && (
            <input
              id="organization"
              name="organization"
              type="text"
              placeholder="Organization Domain (e.g., example.com)"
              autoComplete="organization"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              required
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:border-black outline-none transition-all"
            />
          )}

          <div className="relative">
            <div className="absolute inset-y-0 left-3 flex items-center text-gray-400">
              <IconMail />
            </div>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="Email Address"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full pl-11 pr-4 py-3 border border-gray-200 rounded-xl focus:border-black outline-none transition-all"
            />
          </div>

          <div className="relative">
            <div className="absolute inset-y-0 left-3 flex items-center text-gray-400">
              <IconLock />
            </div>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="Password"
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full pl-11 pr-4 py-3 border border-gray-200 rounded-xl focus:border-black outline-none transition-all"
            />
          </div>

          {error && (
            <div className="text-red-600 text-sm text-center bg-red-50 p-3 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-black text-white py-3 rounded-xl font-semibold text-lg hover:bg-zinc-800 transition-all shadow-md disabled:opacity-50"
          >
            {isLoading 
              ? (authMode === "login" ? "Signing in..." : "Creating account...") 
              : (authMode === "login" ? "Login" : "Create Account")
            }
          </button>
        </form>

        <div className="flex justify-center items-center text-sm text-gray-600 mt-6">
          <span>
            {authMode === "login" ? "Don't have an account?" : "Already have an account?"}
          </span>
          <button
            onClick={toggleMode}
            className="ml-2 px-3 py-1 text-black font-semibold border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
          >
            {authMode === "login" ? "Sign Up" : "Login"}
          </button>
        </div>
      </div>
    </div>
  );
}
