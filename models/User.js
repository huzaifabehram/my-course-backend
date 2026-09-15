const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// FIX: this schema only had name/email/password/role/avatar/bio. Every other
// field the Instructor Dashboard's Profile page sends on save — title,
// location, website, twitter, linkedin, the four total* stats, and the
// description-blocks list — was missing here. Mongoose runs in strict mode
// by default, so any key in an update payload that isn't declared in the
// schema is silently dropped before it ever reaches MongoDB: the API call
// succeeds, the toast says "saved", but a fresh GET after a refresh never
// had the data in the first place. That's the exact bug reported. All of
// the fields below are now declared so they're actually persisted.
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
    },
    role: {
      type: String,
      enum: ['student', 'instructor'],
      default: 'student',
    },
    avatar: {
      type: String,
      default: '',
    },
    bio: {
      type: String,
      default: '',
    },

    // ── Instructor public profile — Profile → Basic Information ──────────
    title: {
      type: String,
      default: '',
    },
    location: {
      type: String,
      default: '',
    },
    website: {
      type: String,
      default: '',
    },
    twitter: {
      type: String,
      default: '',
    },
    linkedin: {
      type: String,
      default: '',
    },

    // ── Instructor public profile — Profile → Public Statistics ──────────
    totalRatings: {
      type: Number,
      default: 0,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    totalStudents: {
      type: Number,
      default: 0,
    },
    totalCourses: {
      type: Number,
      default: 0,
    },

    // ── Instructor public profile — Profile → Description ────────────────
    // Current shape: an ordered list of blocks, e.g.
    //   { type: 'text',  text }
    //   { type: 'image', heading, description, imageUrl }
    //   { type: 'video', heading, description, videoUrl }
    // Mixed (not a strict sub-schema) on purpose, since the three block
    // shapes above don't share the same fields and this list may grow new
    // block types later without another migration.
    instructorDescriptionBlocks: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // ── Legacy fields — kept so any older data (or code still reading
    //    these directly) keeps working. The dashboard no longer writes to
    //    these itself; instructorDescriptionBlocks is the source of truth
    //    going forward. Safe to remove once you've confirmed nothing else
    //    reads them.
    instructorDescription: {
      type: String,
      default: '',
    },
    instructorMedia: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare entered password with hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema); 