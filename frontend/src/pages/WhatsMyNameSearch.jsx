import React, { useState } from 'react';
import { Search, Loader2, Download, ExternalLink, Filter, ShieldCheck, XCircle, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { BACKEND_URL } from '../lib/api';

const CATEGORIES = [
  "All Categories", "archived", "art", "blog", "business", "coding", "dating", 
  "finance", "gaming", "health", "hobby", "images", "misc", "music", "news", 
  "political", "search", "shopping", "social", "tech", "video", "xx NSFW xx"
];

const getCategoryColor = (cat) => {
  const colors = {
    social: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800",
    tech: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800",
    gaming: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800",
    music: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300 border-pink-200 dark:border-pink-800",
    art: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800",
    finance: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
    "xx NSFW xx": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800",
    default: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700"
  };
  return colors[cat] || colors.default;
};

const WhatsMyNameSearch = () => {
  const [username, setUsername] = useState('');
  const [category, setCategory] = useState('All Categories');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  
  const handleSearch = async (e) => {
    e.preventDefault();
    if (!username.trim()) {
      toast.error('Please enter a username');
      return;
    }

    setLoading(true);
    setResults(null);

    try {
      const response = await fetch(`${BACKEND_URL}/api/wmn/search?username=${username}`);
      
      if (!response.ok) throw new Error('Failed to fetch data');
      
      const data = await response.json();
      setResults(data);
      toast.success('Search completed');
    } catch (err) {
      toast.error('Search failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCSV = () => {
    if (!results || !results.foundAccounts) return;
    
    // Convert found accounts to CSV string
    const headers = ['Platform', 'Status', 'URL'];
    const rows = results.foundAccounts
      .filter((acc) => acc.status === 'found')
      .map((acc) => [
        acc.site,
        acc.status,
        acc.url
      ]);
      
    let csvContent = "data:text/csv;charset=utf-8," 
        + headers.join(",") + "\n" 
        + rows.map(e => e.join(",")).join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `wmn_results_${results.username}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredAccounts = results?.foundAccounts?.filter(acc => acc.status === 'found') || [];

  return (
    <div className="min-h-screen bg-[#1e1e2e] text-white p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header matching whatsmyname.app */}
        <div className="text-center space-y-4 py-8">
          <h1 className="text-5xl font-extrabold tracking-tight text-white flex items-center justify-center gap-4">
            <Search className="h-10 w-10 text-teal-400" />
            WhatsMyName
          </h1>
          <p className="text-gray-400 text-lg">
            Discover usernames across multiple websites.
          </p>
        </div>

        {/* Search Controls */}
        <div className="bg-[#2a2a3c] rounded-xl p-6 shadow-xl border border-[#3f3f5a]">
          <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-4 items-center">
            
            <div className="w-full md:w-3/5 relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username (e.g., jsmith)"
                className="w-full bg-[#181825] border border-[#3f3f5a] text-white text-lg rounded-lg pl-12 pr-4 py-3 focus:ring-2 focus:ring-teal-500 focus:border-transparent transition-all"
                disabled={loading}
              />
            </div>

            <div className="w-full md:w-1/4 relative">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-[#181825] border border-[#3f3f5a] text-white text-lg rounded-lg pl-4 pr-10 py-3 appearance-none focus:ring-2 focus:ring-teal-500 transition-all"
                disabled={loading}
              >
                {CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
                <ChevronDown className="h-5 w-5 text-gray-400" />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !username.trim()}
              className="w-full md:w-auto flex-1 flex items-center justify-center gap-2 bg-teal-500 hover:bg-teal-400 text-white font-bold text-lg py-3 px-6 rounded-lg transition-all shadow-lg shadow-teal-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="animate-spin h-6 w-6" /> : <Search className="h-6 w-6" />}
              {loading ? "Searching..." : "Search"}
            </button>
          </form>

          <div className="mt-4 flex items-center justify-between text-sm text-gray-400">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              {loading ? 'Scanning databases...' : 'Ready to search.'}
            </div>
          </div>
        </div>

        {/* Results Container */}
        {results && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-[#2a2a3c] p-4 rounded-xl border border-[#3f3f5a]">
              <div className="flex items-center gap-6">
                <div className="text-gray-300">
                  Total Checked: <span className="font-bold text-white">{results.totalSitesChecked}</span>
                </div>
                <div className="text-gray-300">
                  Accounts Found: <span className="font-bold text-teal-400">{filteredAccounts.length}</span>
                </div>
              </div>
              <button 
                onClick={handleExportCSV}
                className="flex items-center gap-2 px-4 py-2 bg-[#313244] hover:bg-[#45475a] border border-[#3f3f5a] rounded-lg text-sm font-medium transition-colors"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </button>
            </div>

            <div className="bg-[#181825] rounded-xl overflow-hidden border border-[#3f3f5a]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-gray-300">
                  <thead className="bg-[#2a2a3c] text-gray-400 uppercase text-xs">
                    <tr>
                      <th scope="col" className="px-6 py-4 font-semibold">Category</th>
                      <th scope="col" className="px-6 py-4 font-semibold">Site</th>
                      <th scope="col" className="px-6 py-4 font-semibold">Username / Link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#3f3f5a]">
                    {filteredAccounts.length > 0 ? (
                      filteredAccounts.map((account, idx) => (
                        <tr key={idx} className="hover:bg-[#2a2a3c]/50 transition-colors">
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getCategoryColor('tech')}`}>
                              Target
                            </span>
                          </td>
                          <td className="px-6 py-4 font-medium text-white flex items-center gap-2">
                            <ShieldCheck className="h-4 w-4 text-teal-500" />
                            {account.site}
                          </td>
                          <td className="px-6 py-4">
                            <a 
                              href={account.url} 
                              target="_blank" 
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 text-teal-400 hover:text-teal-300 hover:underline"
                            >
                              {account.url}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="3" className="px-6 py-12 text-center text-gray-500">
                          <XCircle className="h-10 w-10 mx-auto mb-3 opacity-50" />
                          <p className="text-lg">No accounts found for '{results.username}'.</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WhatsMyNameSearch;
