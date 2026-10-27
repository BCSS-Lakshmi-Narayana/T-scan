import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ExternalLink } from 'lucide-react';

// Reusable Reason Modal Component - Clean Table Design
// `title`/`notice` let non-alert surfaces (grievances) reuse this modal:
// `notice` renders a banner for states like "analysis still pending".
const ReasonModal = ({ open, onClose, alert, content, analysis, title = 'Alert Analysis Details', notice = null }) => {
    const [isContentExpanded, setIsContentExpanded] = useState(false);

    // --- DATA EXTRACTION (Priority: LLM -> Manual/Root -> Fallback) ---
    const isExpert = !!alert?.llm_analysis;
    const intentLabel = alert?.llm_analysis?.category || alert?.threat_details?.intent || analysis?.intent || alert?.primary_intent || '';
    const llmIntent = alert?.llm_analysis?.intent || '';
    const llmSentiment = alert?.llm_analysis?.sentiment || '';

    // Expert Logic or Reasons
    const reasons = alert?.llm_analysis?.reasoning ? [alert.llm_analysis.reasoning] : (alert?.threat_details?.reasons || analysis?.reasons || []);

    const highlights = alert?.threat_details?.highlights || alert?.triggered_keywords || analysis?.triggered_keywords || alert?.highlights || [];
    const detectedKeywords = alert?.matched_keywords_normalized || highlights || [];
    const riskScore = alert?.llm_analysis?.score ?? alert?.threat_details?.risk_score ?? alert?.risk_score ?? 0;

    // Policies & Laws (Priority: Root Alert fields which are normalized by backend)
    const violatedPolicies = alert?.violated_policies || alert?.threat_details?.violated_policies || (isExpert && alert?.llm_analysis?.platform_policies_violated) || [];
    const legalSections = alert?.legal_sections || alert?.threat_details?.legal_sections || (isExpert && alert?.llm_analysis?.bns_sections_violated) || [];

    const riskLevel = alert?.risk_level || analysis?.risk_level || 'low';
    const explanationText = alert?.classification_explanation || alert?.llm_analysis?.reasoning || alert?.threat_details?.explanation || '';

    const safeReasons = Array.isArray(reasons)
        ? reasons.filter(r => r && typeof r === 'string' && r.trim().length > 0)
        : [];

    // Parse explanation for additional context
    const explanationParts = explanationText ? explanationText.split('|').map(s => s.trim()).filter(Boolean) : [];

    return (
        <Dialog open={open} onOpenChange={onClose}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold border-b pb-3">
                        {title}
                    </DialogTitle>
                </DialogHeader>

                {notice && (
                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                        {notice}
                    </div>
                )}

                <div className="mt-4">
                    {/* MAIN TABLE */}
                    <table className="w-full text-sm border-collapse">
                        <tbody>
                            {/* Risk Summary */}
                            <tr className="border-b">
                                <td className="py-3 pr-4 font-medium text-gray-600 dark:text-gray-400">Risk Summary</td>
                                <td className="py-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-gray-500 dark:text-gray-400">Risk Level:</span>
                                        <Badge className={
                                            riskLevel.toLowerCase() === 'critical' || riskLevel.toLowerCase() === 'high' ? 'bg-red-100 text-red-700 hover:bg-red-200 border-red-200' :
                                                riskLevel.toLowerCase() === 'medium' ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 border-amber-200' :
                                                    'bg-green-100 text-green-700 hover:bg-green-200 border-green-200'
                                        }>
                                            {riskLevel.toUpperCase()}
                                        </Badge>

                                        <span className="text-gray-400">|</span>

                                        <span className="text-gray-500 dark:text-gray-400">Risk Score:</span>
                                        <span className="font-semibold text-base">
                                            {riskScore}%
                                        </span>

                                        <span className="text-gray-400">|</span>

                                        <span className="text-gray-500 dark:text-gray-400">Category:</span>
                                        {alert?.llm_analysis?.category ? (
                                            <Badge variant="outline" className="text-indigo-700 dark:text-indigo-400 border-indigo-200 bg-indigo-50 dark:bg-indigo-900/10">
                                                {alert.llm_analysis.category}
                                            </Badge>
                                        ) : (
                                            <span className="text-gray-400 italic">Uncategorized</span>
                                        )}

                                        {llmIntent && llmIntent !== alert?.llm_analysis?.category && (
                                            <>
                                                <span className="text-gray-400">|</span>
                                                <span className="text-gray-500 dark:text-gray-400">Intent:</span>
                                                <span className="font-medium text-gray-700 dark:text-gray-300">{llmIntent}</span>
                                            </>
                                        )}
                                    </div>
                                </td>
                            </tr>

                            {/* Detected Keywords */}
                            <tr className="border-b">
                                <td className="py-3 pr-4 font-medium text-gray-600 dark:text-gray-400 align-top">Detected Keywords</td>
                                <td className="py-3">
                                    {detectedKeywords.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {detectedKeywords.map((kw, idx) => (
                                                <Badge key={idx} variant="outline" className="text-xs bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/10 dark:text-orange-400">
                                                    {typeof kw === 'string' ? kw : kw.keyword || String(kw)}
                                                </Badge>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="text-gray-400 italic">None detected</span>
                                    )}
                                </td>
                            </tr>

                            {/* Indian Laws Violated */}
                            <tr className="border-b">
                                <td className="py-3 pr-4 font-medium text-gray-600 dark:text-gray-400 align-top">Indian Laws Violated</td>
                                <td className="py-3">
                                    {legalSections.length > 0 ? (
                                        <div className="space-y-2">
                                            {legalSections.map((law, idx) => (
                                                <div key={idx}>
                                                    <span className="font-semibold">{law.act} Section {law.section}</span>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{law.description}</p>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="text-gray-400 italic">None detected</span>
                                    )}
                                </td>
                            </tr>

                            {/* Platform Policies Violated */}
                            <tr className="border-b">
                                <td className="py-3 pr-4 font-medium text-gray-600 dark:text-gray-400 align-top">Platform Policies Violated</td>
                                <td className="py-3">
                                    {violatedPolicies.length > 0 ? (
                                        <div className="space-y-3">
                                            {/* Group by Platform */}
                                            {/* Group by Platform */}
                                            {['x', 'youtube', 'meta'].map(platformGroup => {
                                                let policies = [];
                                                let platformName = '';

                                                if (platformGroup === 'x') {
                                                    policies = violatedPolicies.filter(p => (p.platform || '').toLowerCase() === 'x');
                                                    platformName = 'X (Twitter)';
                                                } else if (platformGroup === 'youtube') {
                                                    policies = violatedPolicies.filter(p => (p.platform || '').toLowerCase() === 'youtube');
                                                    platformName = 'YouTube';
                                                } else if (platformGroup === 'meta') {
                                                    // Combine FB and Insta
                                                    policies = violatedPolicies.filter(p => ['facebook', 'instagram'].includes((p.platform || '').toLowerCase()));
                                                    platformName = 'Meta';

                                                    // Deduplicate by name to avoid repetition (e.g. "Hate Speech" appearing twice)
                                                    const uniqueNames = new Set();
                                                    policies = policies.filter(p => {
                                                        const name = p.name || p.policy_name || p.policy_id || String(p);
                                                        if (uniqueNames.has(name)) return false;
                                                        uniqueNames.add(name);
                                                        return true;
                                                    });
                                                }

                                                if (policies.length === 0) return null;

                                                return (
                                                    <div key={platformGroup}>
                                                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{platformName}</div>
                                                        <div className="space-y-1">
                                                            {policies.map((p, idx) => (
                                                                <div key={idx} className="text-sm border-l-2 border-gray-200 pl-2">
                                                                    {p.name || p.policy_name || p.policy_id || String(p)}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                            {/* Catch-all for legacy/unknown platforms */}
                                            {violatedPolicies.some(p => !['x', 'youtube', 'facebook', 'instagram'].includes((p.platform || '').toLowerCase())) && (
                                                <div>
                                                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Other</div>
                                                    <div className="space-y-1">
                                                        {violatedPolicies.filter(p => !['x', 'youtube', 'facebook', 'instagram'].includes((p.platform || '').toLowerCase())).map((p, idx) => (
                                                            <div key={idx} className="text-sm border-l-2 border-gray-200 pl-2">
                                                                {p.name || p.policy_name || p.policy_id || String(p)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <span className="text-gray-400 italic">None detected</span>
                                    )}
                                </td>
                            </tr>

                            {/* Expert Logic */}
                            <tr className="border-b">
                                <td className="py-3 pr-4 font-medium text-gray-600 dark:text-gray-400 align-top">Expert Logic</td>
                                <td className="py-3">
                                    <div className="space-y-2 text-gray-700 dark:text-gray-300">
                                        {alert?.llm_analysis?.reasoning ? (
                                            <div>{alert.llm_analysis.reasoning}</div>
                                        ) : (
                                            <ul className="list-disc pl-4 space-y-1">
                                                {safeReasons.length > 0 ? safeReasons.map((r, i) => (
                                                    <li key={i}>{r}</li>
                                                )) : (
                                                    <li>{explanationText || "Potential risk detected by internal analysis."}</li>
                                                )}
                                            </ul>
                                        )}
                                    </div>
                                </td>
                            </tr>

                            {/* Subject Content */}
                            <tr className="border-b">
                                <td className="py-3 pr-4 font-medium text-gray-600 dark:text-gray-400 align-top">Subject Content</td>
                                <td className="py-3">
                                    <div className={`whitespace-pre-wrap ${isContentExpanded ? '' : 'line-clamp-3'}`}>
                                        {content?.text || alert?.description || 'No content preview available'}
                                    </div>
                                    {((content?.text || alert?.description || '').length > 100 || ((content?.text || alert?.description || '').match(/\n/g) || []).length >= 2) && (
                                        <button
                                            onClick={() => setIsContentExpanded(!isContentExpanded)}
                                            className="text-xs text-blue-600 dark:text-blue-400 font-medium mt-1 hover:underline"
                                        >
                                            {isContentExpanded ? 'View Less' : 'View More'}
                                        </button>
                                    )}
                                </td>
                            </tr>
                        </tbody>
                    </table>

                    {/* Action Buttons */}
                    <div className="mt-6 flex flex-col gap-2 border-t pt-4">
                        {alert?.content_url && (
                            <Button asChild className="w-full">
                                <a href={alert.content_url} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="h-4 w-4 mr-2" />
                                    Review Original Source
                                </a>
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ReasonModal;
