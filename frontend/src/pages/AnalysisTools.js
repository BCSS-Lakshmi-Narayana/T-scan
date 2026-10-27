import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe, Search, ArrowRight, ExternalLink, ShieldAlert } from 'lucide-react';
import { useRbac } from '../contexts/RbacContext';

const tools = [
  {
    name: 'Global Search',
    featureId: 'global_search',
    description:
      'Run a single query across X, Instagram, Facebook and YouTube. Returns matching profiles and posts in one unified view — useful for quickly checking whether a handle, name, or keyword exists on any monitored platform.',
    icon: Globe,
    href: '/global-search',
    color: 'from-blue-500 to-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    border: 'border-blue-200 dark:border-blue-800',
  },
  {
    name: 'OSINT Tools',
    featureId: 'osint_tools',
    description:
      'Integrated open-source intelligence workspace. Look up an email, username, phone number, image (EXIF / GPS / device), or infrastructure (domains, IPs) and pivot between findings — all in one place, with results saved to your investigation.',
    icon: Search,
    href: '/analysis-tools/osint-tools',
    color: 'from-emerald-500 to-teal-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
  {
    name: 'HCP Cyber Crime LLM',
    featureId: 'hcp_cyber_crime_llm',
    description:
      'Investigative AI workspace tuned for cyber-crime cases. Ask case-specific questions, surface IOCs (indicators of compromise), draft response actions, and get cited answers grounded in the HCP intelligence corpus. Opens in a new tab.',
    icon: ShieldAlert,
    href: 'https://copwriter.in',
    openInNewTab: true,
    color: 'from-violet-600 to-fuchsia-600',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
    border: 'border-violet-200 dark:border-violet-800',
  },
];

const AnalysisTools = () => {
  const navigate = useNavigate();
  const { hasFeatureAccess } = useRbac();
  const visibleTools = tools.filter((tool) => hasFeatureAccess('/analysis-tools', tool.featureId));

  const handleToolClick = (tool) => {
    if (tool.comingSoon) return;

    if (tool.openInNewTab) {
      window.open(tool.href, '_blank', 'noopener,noreferrer');
      return;
    }

    navigate(tool.href, { state: { fromTools: true } });
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Analysis Tools</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Select a tool to get started</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {visibleTools.map((tool) => (
          <button
            key={tool.name}
            onClick={() => handleToolClick(tool)}
            disabled={tool.comingSoon}
            className={`group relative text-left rounded-xl border ${tool.border} ${tool.bg} p-5 transition-all ${tool.comingSoon ? 'opacity-60 cursor-not-allowed' : 'hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]'}`}
          >
            <div className={`inline-flex items-center justify-center h-11 w-11 rounded-lg bg-gradient-to-br ${tool.color} text-white mb-4 shadow-sm`}>
              <tool.icon className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">{tool.name}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{tool.description}</p>
            {!tool.comingSoon && (
              tool.openInNewTab
                ? <ExternalLink className="absolute top-5 right-5 h-4 w-4 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-300 transition-colors" />
                : <ArrowRight className="absolute top-5 right-5 h-4 w-4 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-300 transition-colors" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default AnalysisTools;
