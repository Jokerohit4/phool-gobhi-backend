import { submitContactMessage, listContactMessages, markContactMessageRead } from '../services/contactService.js';

export const submitContact = async (req, res) => {
  try {
    const message = await submitContactMessage(req.body ?? {});
    res.status(201).json({ data: message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listContact = async (req, res) => {
  try {
    const messages = await listContactMessages();
    res.json({ data: messages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const updateContactRead = async (req, res) => {
  try {
    const updated = await markContactMessageRead(req.params.id, req.body?.isRead);
    res.json({ data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
