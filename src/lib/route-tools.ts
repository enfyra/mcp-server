import { registerRouteAccessTools } from './route-access-tools.js';
import { registerRouteDefinitionTools } from './route-definition-tools.js';
import { registerRouteInspectionTools } from './route-inspection-tools.js';

export function registerRouteTools(server, ENFYRA_API_URL) {
  registerRouteInspectionTools(server, ENFYRA_API_URL);
  registerRouteDefinitionTools(server, ENFYRA_API_URL);
  registerRouteAccessTools(server, ENFYRA_API_URL);
}
