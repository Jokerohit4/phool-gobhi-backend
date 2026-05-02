import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  authId: { type: Number, required: true, unique: true }, // auth-service user ID
  name: { type: String, default: '' },
  email: { type: String, required: true },
  phone: { type: String, default: '' },
  profileImageUrl: { type: String, default: '' },
  role: { type: String, enum: ['customer', 'partner', 'gobhi'], default: 'customer' },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
export default User;
