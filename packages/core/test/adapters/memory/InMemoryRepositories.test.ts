import { InMemoryRepositories } from '../../../src/adapters/memory/InMemoryRepositories.js';
import { describeRepositoryContract } from '../../contracts/repositories.contract.js';

describeRepositoryContract('InMemoryRepositories', async () => new InMemoryRepositories());
