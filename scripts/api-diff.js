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
    affectedByComponents: new Map() // Track path/method combinations affected by component changes
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
        Object.entries(methods).forEach(([method, details]) => {
            const usedComponents = new Set();
            findComponentRefs(details, usedComponents);
            
            for (const comp of usedComponents) {
                if (changes.components.has(comp)) {
                    const key = `${path}::${method.toUpperCase()}`;
                    if (!changes.affectedByComponents.has(key)) {
                        changes.affectedByComponents.set(key, {
                            path,
                            method: method.toUpperCase(),
                            components: new Set()
                        });
                    }
                    changes.affectedByComponents.get(key).components.add(comp);
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
            } else {
                const changedFields = getChanges(previousMethods[method], details);
                if (changedFields.length > 0) {  // Only add if there are meaningful changes
                    if (!changes.modified[path]) changes.modified[path] = [];
                    changes.modified[path].push({
                        method: method.toUpperCase(),
                        changes: changedFields
                    });
                }
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
    const fields = ['operationId', 'parameters', 'requestBody', 'responses'];
    
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

    // Check additionalProperties
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        if (schemaReferencesComponent(schema.additionalProperties, componentName, visitedRefs)) {
            return true;
        }
    }
    
    return false;
}

// Helper function to detect where a component is used in an endpoint
function findComponentUsage(details, componentName) {
    const usage = [];
    
    // Check parameters
    if (details.parameters) {
        const hasComponent = details.parameters.some(p => {
            // Check direct parameter reference
            if (p.$ref && p.$ref.includes(`/parameters/${componentName}`)) return true;
            // Check schema reference if it exists
            if (p.schema && schemaReferencesComponent(p.schema, componentName)) return true;
            // Check examples
            if (p.examples && Object.values(p.examples).some(e => 
                e.$ref && e.$ref.includes(`/examples/${componentName}`))) return true;
            return false;
        });
        if (hasComponent) usage.push('parameters');
    }
    
    // Check requestBody
    if (details.requestBody) {
        if (details.requestBody.$ref && details.requestBody.$ref.includes(componentName)) {
            usage.push('requestBody');
        } else if (details.requestBody.content) {
            const hasComponent = Object.values(details.requestBody.content).some(c => {
                if (c.schema && schemaReferencesComponent(c.schema, componentName)) return true;
                if (c.examples && Object.values(c.examples).some(e => 
                    e.$ref && e.$ref.includes(`/examples/${componentName}`))) return true;
                return false;
            });
            if (hasComponent) usage.push('requestBody');
        }
    }
    
    // Check responses
    if (details.responses) {
        const hasComponent = Object.entries(details.responses).some(([code, response]) => {
            if (response.$ref && response.$ref.includes(`/responses/${componentName}`)) return true;
            if (response.content) {
                return Object.values(response.content).some(c => {
                    if (c.schema && schemaReferencesComponent(c.schema, componentName)) return true;
                    if (c.examples && Object.values(c.examples).some(e => 
                        e.$ref && e.$ref.includes(`/examples/${componentName}`))) return true;
                    return false;
                });
            }
            if (response.headers) {
                return Object.values(response.headers).some(h => 
                    schemaReferencesComponent(h.schema, componentName));
            }
            return false;
        });
        if (hasComponent) usage.push('responses');
    }
    
    return usage;
}

// Generate markdown release notes
function generateReleaseNotes() {
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

    // Modified endpoints
    if (Object.keys(changes.modified).length > 0 || changes.affectedByComponents.size > 0) {
        let section = '## Modified\n';

        // First show all directly modified paths
        Object.entries(changes.modified)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([path, methodChanges]) => {
                methodChanges
                    .sort((a, b) => a.method.localeCompare(b.method))
                    .forEach(({method, changes: methodChanges}) => {
                        section += `- [${method}] \`${path}\`\n`;
                        methodChanges.sort().forEach(change => {
                            section += `  - ${change}\n`;
                        });
                    });
            });

        // Then handle component-affected paths
        const componentAffectedPaths = new Map();
        
        for (const [_, value] of changes.affectedByComponents) {
            const { path, method, components } = value;
            // Skip if this path/method was already shown in direct modifications
            if (changes.modified[path]?.some(m => m.method === method)) continue;
            
            if (!componentAffectedPaths.has(path)) {
                componentAffectedPaths.set(path, new Map());
            }
            componentAffectedPaths.get(path).set(method, Array.from(components));
        }

        // Show first 5 component-affected paths
        const sortedComponentPaths = Array.from(componentAffectedPaths.keys()).sort();
        const visibleComponentPaths = sortedComponentPaths.slice(0, 5);
        
        // Add a blank line before component-affected paths if there were direct modifications
        if (Object.keys(changes.modified).length > 0 && visibleComponentPaths.length > 0) {
            section += '\n';
        }

        visibleComponentPaths.forEach(path => {
            const methods = componentAffectedPaths.get(path);
            Array.from(methods.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([method, components]) => {
                    section += `- [${method}] \`${path}\`\n`;
                    const methodDetails = currentSpec.paths[path][method.toLowerCase()];
                    components
                        .sort()
                        .forEach(component => {
                            const usageLocations = findComponentUsage(methodDetails, component).sort();
                            if (usageLocations.length > 0) {
                                section += `  - \`${component}\` modified in ${usageLocations.join(', ')}\n`;
                            }
                        });
                });
        });

        // Collapse remaining component-affected paths
        const remainingPaths = sortedComponentPaths.slice(5);
        if (remainingPaths.length > 0) {
            section += '\n<details><summary>Show more routes affected by component changes...</summary>\n\n';
            remainingPaths.forEach(path => {
                const methods = componentAffectedPaths.get(path);
                Array.from(methods.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .forEach(([method, components]) => {
                        section += `- [${method}] \`${path}\`\n`;
                        const methodDetails = currentSpec.paths[path][method.toLowerCase()];
                        components
                            .sort()
                            .forEach(component => {
                                const usageLocations = findComponentUsage(methodDetails, component).sort();
                                if (usageLocations.length > 0) {
                                    section += `  - \`${component}\` modified in ${usageLocations.join(', ')}\n`;
                                }
                            });
                    });
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

    return sections.join('\n');
}

// Main execution
compareComponents();
findAffectedPaths();
comparePaths();
const releaseDescription = generateReleaseNotes();

// Write release notes to markdown file
fs.writeFileSync('release-description.md', releaseDescription);
