import { createRegionalWorker } from '../src/services/RegionalWorker';
export default { fetch: createRegionalWorker(2) };
