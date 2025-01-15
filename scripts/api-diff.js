const fs = require('fs');

// Read the JSON files
const previousSpec = JSON.parse(fs.readFileSync('previous.json', 'utf8'));
const currentSpec = JSON.parse(fs.readFileSync('current.json', 'utf8'));

// Initialize change tracking
const changes = {
    added: {},      // Group by path
    removed: {},    // Group by path
    modified: {},   // Group by path
    components: new Set(),  // Track changed components
    affectedByComponents: {} // Track paths affected by component changes
};

// Helper function to track component references
function findComponentRefs(obj, components, spec = currentSpec) {
    if (!obj) return;
    if (typeof obj === 'object') {
        if (obj['$ref'] && obj['$ref'].startsWith('#/components/')) {
            const componentName = obj['$ref'].split('/').pop();
            components.add(componentName);
            
            // Follow the reference to check nested components
            const [_, category, name] = obj['$ref'].split('/');
            const referencedComponent = spec.components?.[category]?.[name];
            if (referencedComponent) {
                findComponentRefs(referencedComponent, components, spec);
            }
        }
        Object.values(obj).forEach(value => findComponentRefs(value, components, spec));
    }
}

// Compare components first
function compareComponents() {
    const prevComps = previousSpec.components || {};
    const currComps = currentSpec.components || {};
    
    for (const [category, components] of Object.entries(currComps)) {
        for (const [name, def] of Object.entries(components)) {
            const prevDef = prevComps[category]?.[name];
            if (!prevDef || JSON.stringify(prevDef) !== JSON.stringify(def)) {
                changes.components.add(name);
                
                // Also check which components reference this changed component
                Object.entries(currComps[category] || {}).forEach(([otherName, otherDef]) => {
                    const refsSet = new Set();
                    findComponentRefs(otherDef, refsSet);
                    if (refsSet.has(name)) {
                        changes.components.add(otherName);
                    }
                });
            }
        }
    }
}

// Find paths affected by component changes
function findAffectedPaths() {
    if (changes.components.size === 0) return;

    Object.entries(currentSpec.paths || {}).forEach(([path, methods]) => {
        const affectedMethods = [];
        Object.entries(methods).forEach(([method, details]) => {
            const usedComponents = new Set();
            findComponentRefs(details, usedComponents);
            
            for (const comp of usedComponents) {
                if (changes.components.has(comp)) {
                    affectedMethods.push(method.toUpperCase());
                    if (!changes.affectedByComponents[path]) {
                        changes.affectedByComponents[path] = {
                            methods: new Set(),
                            components: new Set()
                        };
                    }
                    changes.affectedByComponents[path].methods.add(method.toUpperCase());
                    changes.affectedByComponents[path].components.add(comp);
                }
            }
        });
    });
}

// Compare paths and methods
function comparePaths() {
    // Check for added and modified endpoints
    Object.entries(currentSpec.paths || {}).forEach(([path, methods]) => {
        const previousMethods = previousSpec.paths?.[path] || {};
        
        Object.entries(methods).forEach(([method, details]) => {
            if (!previousMethods[method]) {
                if (!changes.added[path]) changes.added[path] = new Set();
                changes.added[path].add(method.toUpperCase());
            } else if (JSON.stringify(previousMethods[method]) !== JSON.stringify(details)) {
                if (!changes.modified[path]) changes.modified[path] = [];
                changes.modified[path].push({
                    method: method.toUpperCase(),
                    changes: getChanges(previousMethods[method], details)
                });
            }
        });
    });

    // Check for removed endpoints
    Object.entries(previousSpec.paths || {}).forEach(([path, methods]) => {
        Object.keys(methods).forEach(method => {
            if (!currentSpec.paths?.[path]?.[method]) {
                if (!changes.removed[path]) changes.removed[path] = new Set();
                changes.removed[path].add(method.toUpperCase());
            }
        });
    });
}

function getChanges(previous, current) {
    const changes = [];
    const fields = ['summary', 'description', 'operationId', 'parameters', 'requestBody', 'responses'];
    
    fields.forEach(field => {
        if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
            changes.push(field);
        }
    });
    
    return changes;
}

// Helper function to check if a schema references a component or its dependencies
function schemaReferencesComponent(schema, componentName, visitedRefs = new Set()) {
    if (!schema) return false;
    
    // Prevent infinite recursion
    const schemaKey = JSON.stringify(schema);
    if (visitedRefs.has(schemaKey)) return false;
    visitedRefs.add(schemaKey);
    
    // Direct reference check
    if (schema.$ref) {
        const refPath = schema.$ref;
        if (refPath === `#/components/schemas/${componentName}`) return true;
        
        // Follow the reference to check nested components
        const [_, category, name] = refPath.split('/');
        const referencedComponent = currentSpec.components?.[category]?.[name];
        if (referencedComponent && schemaReferencesComponent(referencedComponent, componentName, visitedRefs)) {
            return true;
        }
    }
    
    // Check combiners (oneOf, anyOf, allOf)
    for (const combiner of ['oneOf', 'anyOf', 'allOf']) {
        if (schema[combiner] && Array.isArray(schema[combiner])) {
            if (schema[combiner].some(s => schemaReferencesComponent(s, componentName, visitedRefs))) {
                return true;
            }
        }
    }
    
    // Check properties if it's an object
    if (schema.properties) {
        if (Object.values(schema.properties).some(prop => 
            schemaReferencesComponent(prop, componentName, visitedRefs))) {
            return true;
        }
    }
    
    // Check array items
    if (schema.items && schemaReferencesComponent(schema.items, componentName, visitedRefs)) {
        return true;
    }
    
    return false;
}

// Helper function to detect where a component is used in an endpoint
function findComponentUsage(details, componentName) {
    const usage = [];
    
    // Check parameters
    if (details.parameters) {
        const hasComponent = details.parameters.some(p => 
            (p.$ref && schemaReferencesComponent({ $ref: p.$ref }, componentName)) ||
            (p.schema && schemaReferencesComponent(p.schema, componentName))
        );
        if (hasComponent) usage.push('parameters');
    }
    
    // Check requestBody
    if (details.requestBody) {
        let hasComponent = false;
        if (details.requestBody.$ref) {
            hasComponent = schemaReferencesComponent({ $ref: details.requestBody.$ref }, componentName);
        } else if (details.requestBody.content) {
            hasComponent = Object.values(details.requestBody.content).some(c => 
                c.schema && schemaReferencesComponent(c.schema, componentName)
            );
        }
        if (hasComponent) usage.push('requestBody');
    }
    
    // Check responses
    if (details.responses) {
        const hasComponent = Object.entries(details.responses).some(([code, r]) => {
            if (r.$ref) return schemaReferencesComponent({ $ref: r.$ref }, componentName);
            if (r.content) {
                return Object.values(r.content).some(c => 
                    c.schema && schemaReferencesComponent(c.schema, componentName)
                );
            }
            return false;
        });
        if (hasComponent) usage.push('responses');
    }
    
    return usage;
}

// Generate markdown release notes
function generateReleaseNotes() {
    let releaseDescription = '';
    

    const sections = [];

    // Added endpoints
    if (Object.keys(changes.added).length > 0) {
        let section = '## Added\n';
        Object.entries(changes.added)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([path, methods]) => {
                section += `- [${Array.from(methods).sort().join('] [')}] \`${path}\`\n`;
            });
        sections.push(section);
    }

    // Helper function to generate route modification details
    function generateModifiedRouteDetails(path, changes) {
        let details = '';
        const methodsToProcess = new Set();
        
        // Collect all affected methods
        if (changes.modified[path]) {
            changes.modified[path].forEach(({method}) => methodsToProcess.add(method));
        }
        if (changes.affectedByComponents[path]) {
            changes.affectedByComponents[path].methods.forEach(method => methodsToProcess.add(method));
        }

        // Process each method
        Array.from(methodsToProcess)
            .sort()
            .forEach(method => {
                details += `- [${method}] \`${path}\`\n`;
                
                // Add direct changes
                const directChanges = changes.modified[path]?.find(m => m.method === method);
                if (directChanges) {
                    directChanges.changes.sort().forEach(change => {
                        details += `  - ${change}\n`;
                    });
                }

                // Add component changes
                if (changes.affectedByComponents[path]?.methods.has(method)) {
                    const methodDetails = currentSpec.paths[path][method.toLowerCase()];
                    Array.from(changes.affectedByComponents[path].components)
                        .sort()
                        .forEach(component => {
                            const usageLocations = findComponentUsage(methodDetails, component).sort();
                            details += `  - \`${component}\` modified in ${usageLocations.join(', ')}\n`;
                        });
                }
            });
        return details;
    }

    // Modified endpoints
    if (Object.keys(changes.modified).length > 0 || Object.keys(changes.affectedByComponents).length > 0) {
        let section = '## Modified\n';
        
        // First show all directly modified paths
        const directlyModifiedPaths = Object.keys(changes.modified).sort();
        directlyModifiedPaths.forEach(path => {
            section += generateModifiedRouteDetails(path, changes);
        });

        // Then show component-affected paths (but not ones that were directly modified)
        const componentAffectedEntries = Object.entries(changes.affectedByComponents)
            .filter(([path]) => !changes.modified[path]) // Only paths not already shown above
            .flatMap(([path, details]) => 
                Array.from(details.methods).map(method => ({path, method}))
            )
            .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

        // Show first 5 component-affected method-path combinations
        const visibleEntries = componentAffectedEntries.slice(0, 5);
        const processedPaths = new Set();
        
        visibleEntries.forEach(({path}) => {
            if (!processedPaths.has(path)) {
                section += generateModifiedRouteDetails(path, changes);
                processedPaths.add(path);
            }
        });

        // Collapse any remaining entries
        const remainingEntries = componentAffectedEntries.slice(5);
        if (remainingEntries.length > 0) {
            section += '\n<details><summary>Show more routes affected by component changes...</summary>\n\n';
            const remainingPaths = new Set();
            remainingEntries.forEach(({path}) => remainingPaths.add(path));
            Array.from(remainingPaths).sort().forEach(path => {
                section += generateModifiedRouteDetails(path, changes);
            });
            section += '</details>\n';
        }
        
        sections.push(section);
    }

    // Removed endpoints
    if (Object.keys(changes.removed).length > 0) {
        let section = '## Removed\n';
        Object.entries(changes.removed)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([path, methods]) => {
                section += `- [${Array.from(methods).sort().join('] [')}] \`${path}\`\n`;
            });
        sections.push(section);
    }


    // Sort sections alphabetically and combine
    sections.sort((a, b) => {
        const titleA = a.split('\n')[0];
        const titleB = b.split('\n')[0];
        return titleA.localeCompare(titleB);
    });

    releaseDescription += sections.join('\n');

    return releaseDescription;
}

// Main execution
compareComponents();
findAffectedPaths();
comparePaths();
const releaseDescription = generateReleaseNotes();

// Write release notes to markdown file
fs.writeFileSync('release-description.md', releaseDescription);
