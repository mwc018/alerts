import { Router } from 'express';
import databaseService from '../services/databaseService.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(databaseService.getAllClients());
});

router.post('/', (req, res) => {
  const { site_name } = req.body;
  if (!site_name?.trim()) {
    res.status(400).json({ error: 'site_name is required' });
    return;
  }
  try {
    const client = databaseService.createClient(req.body);
    res.status(201).json(client);
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) {
      res.status(409).json({ error: `A client named "${site_name}" already exists` });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = databaseService.updateClient(id, req.body);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.json(client);
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = databaseService.deleteClient(id);
  if (!deleted) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.status(204).send();
});

export default router;
