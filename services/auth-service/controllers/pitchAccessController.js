import {
  checkPitchAccess,
  listPitchAccessContacts,
  addPitchAccessContact,
  removePitchAccessContact,
} from '../services/pitchAccessService.js';

export const checkContact = async (req, res) => {
  try {
    const allowed = await checkPitchAccess(req.body?.contact);
    res.json({ allowed });
  } catch (err) {
    res.status(500).json({ allowed: false });
  }
};

export const listContacts = async (req, res) => {
  try {
    const contacts = await listPitchAccessContacts();
    res.json({ data: contacts });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const addContact = async (req, res) => {
  try {
    const contact = await addPitchAccessContact(req.body ?? {});
    res.status(201).json({ data: contact });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const removeContact = async (req, res) => {
  try {
    await removePitchAccessContact(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
