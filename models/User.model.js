// server/models/User.model.js
// ─── User schema: supports both students and instructors ─────────────────────

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
    },
    role: {
      type: String,
      enum: ["student", "instructor"],
      default: "student",
    },
    // Instructor profile fields
    bio:                   { type: String, default: "" },
    title:                 { type: String, default: "" },
    avatar:                { type: String, default: "" },
    location:              { type: String, default: "" },
    website:               { type: String, default: "" },
    twitter:               { type: String, default: "" },
    linkedin:              { type: String, default: "" },
    instructorDescription: { type: String, default: "" },
    // Manually set display stats (not auto-calculated)
    totalRatings:  { type: Number, default: 0 },
    totalReviews:  { type: Number, default: 0 },
    totalStudents: { type: Number, default: 0 },
    totalCourses:  { type: Number, default: 0 },

    // Student-specific: list of enrolled course IDs
    enrolledCourses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
      },
    ],
  },
  { timestamps: true }
);

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", UserSchema);
