// server/models/Course.model.js
// ─── Course schema with sections and lectures ─────────────────────────────────

const mongoose = require("mongoose");

const LectureSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, enum: ["video", "pdf", "audio", "quiz"], default: "video" },
  duration: { type: String, default: "" },
  videoUrl: { type: String, default: "" },
  free: { type: Boolean, default: false },
});

const SectionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  lectures: [LectureSchema],
});

const CourseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Course title is required"],
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "General",
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    thumbnail: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["draft", "published", "review"],
      default: "draft",
    },
    // Reference to the instructor who created this course
    instructor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sections: [SectionSchema],

    // Stats
    studentsEnrolled: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Course", CourseSchema);
