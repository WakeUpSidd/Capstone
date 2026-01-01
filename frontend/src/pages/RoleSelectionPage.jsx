import React, { useState } from 'react';

export default function RoleSelectionPage({ onRoleSelect }) {
  const [selectedRole, setSelectedRole] = useState(null);

  const roles = [
    {
      id: 'user',
      title: 'I am a User',
      description: 'Personal dashboard and individual tools.',
    },
    {
      id: 'organisation',
      title: 'I am an Organisation',
      description: 'Manage a company profile, members, and settings.',
    },
  ];

  return (
    // min-h-screen and w-full ensure the background covers the whole page
    <div className="fade-in min-h-screen w-full bg-gray-100 flex flex-col items-center justify-center p-4">
      
      {/* Brand Header */}
      <div className="w-full max-w-[800px] mb-6 px-2">
        <h2 className="text-xl font-bold text-[#0F172A]">
          Soch AI
        </h2>
      </div>

      {/* Main Container */}
      <div className="bg-white w-full max-w-[800px] rounded-3xl p-12 shadow-sm border border-gray-100">
        <h1 className="text-4xl font-bold text-[#0F172A] mb-3">Welcome</h1>
        <p className="text-gray-500 text-lg mb-10">Choose how you want to use the platform.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {roles.map((role) => (
            <button
              key={role.id}
              onClick={() => setSelectedRole(role.id)}
              className={`text-left p-8 rounded-2xl border-2 transition-all duration-200 ${
                selectedRole === role.id
                  ? 'border-black bg-white'
                  : 'border-gray-100 hover:border-gray-200 bg-white'
              }`}
            >
              <h3 className="text-xl font-bold text-[#0F172A] mb-3">{role.title}</h3>
              <p className="text-gray-500 leading-relaxed">
                {role.description}
              </p>
            </button>
          ))}
        </div>

        {/* Action Button */}
        <button
          disabled={!selectedRole}
          onClick={() => onRoleSelect(selectedRole)}
          className={`w-full py-5 rounded-2xl font-semibold text-lg transition-all ${
            selectedRole
              ? 'bg-black text-white hover:bg-gray-700'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          Continue
        </button>
      </div>
    </div>
  );
}