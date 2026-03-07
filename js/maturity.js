// Generate improvement suggestions based on current maturity tier and metrics
export function getMaturityImprovementSuggestions(tier, completeness, docLevel) {
  const suggestions = [];
  const comp = Number(completeness) || 0;
  
  if (tier === 'platinum') {
    // Already at highest tier - no suggestions
    return [];
  }

  if (tier === 'gold') {
    // Gold → Platinum suggestions
    suggestions.push('Achieve a near-perfect score (95+) to reach Platinum status');
    if (comp < 95) {
      suggestions.push(`Increase completeness from ${comp}% toward 95%+ by addressing remaining data gaps`);
    }
    if (docLevel !== 'complete') {
      suggestions.push('Achieve "Complete" documentation with full field definitions and lineage');
    }
    suggestions.push('Ensure all service metadata fields are populated (description, copyright, subject)');
    suggestions.push('Minimize null rates across all attribute columns');
    return suggestions;
  }
  
  if (tier === 'bronze') {
    // Bronze → Silver suggestions
    if (comp < 80) {
      suggestions.push(`Increase completeness from ${comp}% to at least 80% by filling in missing attribute values`);
    }
    if (!docLevel || docLevel === 'none' || docLevel === 'minimal') {
      suggestions.push('Improve documentation level to at least "Partial" by adding field descriptions and metadata');
    }
    suggestions.push('Ensure consistent attribute naming conventions across the dataset');
    suggestions.push('Add or verify contact information and data steward assignment');
  } else if (tier === 'silver') {
    // Silver → Gold suggestions
    if (comp < 90) {
      suggestions.push(`Increase completeness from ${comp}% to at least 90% by addressing remaining data gaps`);
    }
    if (docLevel !== 'complete') {
      suggestions.push('Achieve "Complete" documentation with full field definitions, lineage, and usage notes');
    }
    suggestions.push('Implement automated data quality checks and validation rules');
    suggestions.push('Establish a regular update schedule and document the update frequency');
  } else {
    // Unknown or no tier - general suggestions
    if (comp < 70) {
      suggestions.push('Improve data completeness by filling in missing values');
    }
    if (!docLevel || docLevel === 'none') {
      suggestions.push('Add basic documentation including field descriptions');
    }
    suggestions.push('Assign a quality tier (bronze/silver/gold/platinum) to track maturity');
  }
  
  return suggestions;
}
