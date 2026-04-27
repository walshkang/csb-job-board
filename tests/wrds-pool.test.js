const { connect, query, close } = require('../src/utils/wrds-pool');
const { Client: SSHClient } = require('ssh2');
const { Client: PGClient } = require('pg');

// Mock dependencies
jest.mock('ssh2');
jest.mock('pg');

describe('wrds-pool', () => {
  let mockSshClient;
  let mockPgClient;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    mockSshClient = {
      on: jest.fn().mockReturnThis(),
      connect: jest.fn(),
      forwardOut: jest.fn(),
      end: jest.fn(),
    };
    SSHClient.mockImplementation(() => mockSshClient);

    mockPgClient = {
      connect: jest.fn().mockResolvedValue(),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn(),
    };
    PGClient.mockImplementation(() => mockPgClient);

    // Mock config
    jest.mock('../src/config', () => ({
      wrds: {
        sshHost: 'ssh.test',
        sshPort: 22,
        pgHost: 'pg.test',
        pgPort: 5432,
        username: 'testuser',
        password: 'testpassword',
        database: 'testdb',
      }
    }), { virtual: true });

    // Force reloading the module so it uses the mocked config
    jest.isolateModules(() => {
      const wrdsPool = require('../src/utils/wrds-pool');
      // Assign the exported functions to outer scope variables so tests can call them
      Object.assign(this, wrdsPool);
    });
  });

  afterEach(async () => {
    await close();
  });

  it('should establish SSH and PG connections', async () => {
    // Setup SSH connect mock to simulate success
    mockSshClient.connect.mockImplementation(function() {
      // Simulate ready event
      setTimeout(() => this.on.mock.calls.find(call => call[0] === 'ready')[1](), 10);
    });

    // Setup SSH forwardOut mock to simulate success
    const mockStream = {
      emit: jest.fn(),
    };
    mockSshClient.forwardOut.mockImplementation((srcIP, srcPort, destIP, destPort, cb) => {
      cb(null, mockStream);
    });

    await connect();

    expect(SSHClient).toHaveBeenCalledTimes(1);
    expect(mockSshClient.connect).toHaveBeenCalled();
    expect(mockSshClient.forwardOut).toHaveBeenCalled();
    expect(PGClient).toHaveBeenCalledTimes(1);
    expect(mockPgClient.connect).toHaveBeenCalled();
  });

  it('should handle SSH connection failure', async () => {
    mockSshClient.connect.mockImplementation(function() {
      setTimeout(() => this.on.mock.calls.find(call => call[0] === 'error')[1](new Error('SSH Error')), 10);
    });

    await expect(connect()).rejects.toThrow('SSH connection failed: SSH Error');
  });

  it('should patch the socket stream for pg compatibility', async () => {
    mockSshClient.connect.mockImplementation(function() {
      setTimeout(() => this.on.mock.calls.find(call => call[0] === 'ready')[1](), 10);
    });

    const mockStream = { emit: jest.fn() };
    mockSshClient.forwardOut.mockImplementation((srcIP, srcPort, destIP, destPort, cb) => {
      cb(null, mockStream);
    });

    await connect();

    expect(typeof mockStream.setNoDelay).toBe('function');
    expect(typeof mockStream.setKeepAlive).toBe('function');
    expect(typeof mockStream.connect).toBe('function');
    expect(typeof mockStream.destroy).toBe('function');
  });

  it('query should auto-connect and execute', async () => {
    mockSshClient.connect.mockImplementation(function() {
      setTimeout(() => this.on.mock.calls.find(call => call[0] === 'ready')[1](), 10);
    });
    mockSshClient.forwardOut.mockImplementation((sI, sP, dI, dP, cb) => cb(null, {}));
    
    mockPgClient.query.mockResolvedValue({ rows: [{ id: 1 }] });

    const result = await query('SELECT * FROM test');

    expect(mockPgClient.query).toHaveBeenCalledWith('SELECT * FROM test', []);
    expect(result.rows).toHaveLength(1);
  });
});
