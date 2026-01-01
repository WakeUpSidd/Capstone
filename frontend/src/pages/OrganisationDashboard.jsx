import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { organizationApi } from '../services/api';

// Icon for Logout
const IconLogout = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
  </svg>
);

export default function OrganisationDashboard({ onLogout }) {
  const { user } = useAuth();
  const [org, setOrg] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Get the initial of the organisation name (e.g., 'O' for 'org1')
  const orgInitial = org?.name 
    ? org.name.charAt(0).toUpperCase() 
    : (user?.name ? user.name.charAt(0).toUpperCase() : 'O');

  useEffect(() => {
    (async () => {
      try {
        setError('');
        if (!user?.id) { setLoading(false); return; }
        const [{ data: orgRes }, { data: memRes }] = await Promise.all([
          organizationApi.getOrganization(user.id),
          organizationApi.getAllMembers(user.id),
        ]);
        setOrg(orgRes?.data || null);
        setMembers(memRes?.members || []);
      } catch (e) {
        const msg = e?.response?.data?.error || 'Failed to load organization data.';
        setError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

  return (
    <div className="min-h-screen bg-white text-black font-sans">
      {/* --- HEADER --- */}
      <header className="h-20 border-b border-gray-100 flex items-center justify-between px-8 bg-white sticky top-0 z-50">
        {/* Increased font size */}
        <h1 className="text-xl font-bold tracking-tight text-black">Organisation dashboard</h1>
        
        <div className="flex items-center gap-6">
          {/* Profile icon contains organisation initial */}
          <div className="w-10 h-10 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center text-sm font-bold text-black shadow-sm">
            {orgInitial}
          </div>
          <button 
            onClick={onLogout}
            className="flex items-center gap-2 text-sm font-bold text-gray-800 hover:text-black transition-colors"
          >
            <IconLogout /> Log out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto py-12 px-6 space-y-10 fade-in">
        
        {/* --- ORGANISATION DETAILS --- */}
        <section className="bg-white border border-gray-100 rounded-2xl p-10 shadow-sm">
          <h2 className="text-xl font-bold mb-8">Organisation details</h2>
          
          <div className="space-y-8">
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Organisation name</p>
              <p className="text-sm font-bold text-black">{org?.name || 'org1'}</p>
            </div>
            
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Domain</p>
              <p className="text-sm font-medium text-black">{org?.domain || 'gmail.com'}</p>
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Owner email</p>
              <p className="text-sm font-medium text-black">{org?.email || user?.email}</p>
            </div>
          </div>
        </section>

        {/* --- MEMBERS LIST --- */}
        <section className="bg-white border border-gray-100 rounded-2xl p-10 shadow-sm">
          <div className="flex items-center gap-3 mb-10">
            <h2 className="text-xl font-bold">Members</h2>
            <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-2.5 py-1 rounded-full border border-gray-200">
              {members.length}
            </span>
          </div>

          {error && <p className="mb-4 text-xs text-red-600 bg-red-50 p-3 rounded-lg">{error}</p>}

          <div className="w-full">
            {/* Table Header */}
            <div className="grid grid-cols-12 px-2 pb-4 border-b border-gray-100">
              <p className="col-span-4 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Name</p>
              <p className="col-span-5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Email</p>
              <p className="col-span-3 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-right">Role</p>
            </div>

            {/* Member Rows */}
            <div className="divide-y divide-gray-50">
              {members.map((m) => (
                <div key={m._id} className="grid grid-cols-12 px-2 py-5 items-center hover:bg-gray-50/50 transition-colors">
                  <p className="col-span-4 text-sm font-bold text-black">{m.name || 'User'}</p>
                  <p className="col-span-5 text-sm font-medium text-gray-500">{m.email}</p>
                  <div className="col-span-3 text-right">
                    <span className="text-[10px] font-bold text-black px-2.5 py-1 rounded border border-gray-200 bg-white">
                      {m.role ? m.role.toUpperCase() : 'USER'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}