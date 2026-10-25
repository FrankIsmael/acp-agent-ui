# Session Summary: Anatomy Skill, CNC Lathe Visualization & Alternative Approaches

**Date context:** October 2026  
**Original post:** [@maricelcintya](https://x.com/maricelcintya/status/2112689755435499878)

---

## 1. Original X Post Context

Mari (@maricelcintya) shared a test of the open-source **Anatomy** skill for Claude:

- She generated an interactive isometric visualization of a **horizontal CNC lathe** (torno paralelo) machining a steel gym dumbbell (mancuerna).
- The process used multiple roughing passes based on CNC programming.
- Video showed progressive material removal with live weight/position updates.
- She noted missing realistic details: metal chips (viruta) exiting the machine and coolant fluid.
- Personal background: Her father is/was a turner and owns a machining factory.

**Anatomy skill** ([GitHub – wheresryan22/anatomy](https://github.com/wheresryan22/anatomy)):
- Claude skill that explains technical concepts by building detailed, interactive isometric machines/systems.
- Outputs polished SVGs (with optional WebGL shaders and beta 3D).
- Generates many precisely fitted parts, motion, live readouts, and self-audits.
- High token consumption because the model must invent, describe, and code the entire assembly.

---

## 2. Core Discussion: Token Cost vs. Specialized Simulation

**Problem identified:**  
Generating complex multi-part SVG animations with Anatomy is token-heavy (reasoning + large code output). Complex examples can consume millions of tokens.

**Proposed alternative:**
Create a dedicated web app with a **built-in 3D CNC horizontal lathe** (using Three.js / react-three-fiber or similar).

- Hard-code the lathe kinematics once (bed, headstock, spindle, chuck, carriage, cross-slide, toolpost, tailstock, etc.).
- Implement programmatic material removal (CSG, voxels, or SDF).
- Optionally add chips, coolant, realistic spindle rotation, and collision detection.
- Ask the AI **only** for:
  - Workpiece geometry (bar size + final profile)
  - Tooling
  - Process / toolpaths (roughing + finishing passes or G-code)

**Benefits:**
- Dramatically lower token usage
- Higher realism and interactivity
- Instant re-simulation when parameters change
- Educational value for CNC programming and machining
- Reusable base model

**Audience considerations:**
- Strongly useful for people interested in real machining, CNC students, hobbyists, or professionals.
- Less appealing to the broader Anatomy audience, who often prefer the polished, general-purpose, shareable isometric SVG “craft” aesthetic and the ability to generate *any* machine on demand.

**Conclusion:** Complementary approaches, not competitors. A hybrid (Anatomy for quick general explanations + specialized Three.js lathe simulator for machining depth) is ideal.

---

## 3. Existing Pure CNC Simulators

### Desktop / Installable
| Tool | Type | Strengths | Lathe Support | Notes |
|------|------|-----------|---------------|-------|
| **CAMotics** | Free, open-source | Excellent 3D stock removal, tool tables, cross-platform | No (milling only) | Most popular free desktop option |
| **CNC Simulator Pro** | Commercial | Full virtual machines, controllers, collision detection, CAD/CAM | Yes | Windows-focused training tool |
| **Swansoft CNC Simulator** | Commercial/Educational | Emulates real control panels, realistic 3D | Yes | Strong for operator training |
| Mobile apps (CNC Simulator Lite, Lathe Simulator Lite) | Free/Paid Android | Simplified 3D G-code practice | Yes | Good for basic learning |

### Browser-based / Web Apps (No install)
| Name | Type | Key Features | Lathe Support | Notes |
|------|------|--------------|---------------|-------|
| **CNC Simulator Pro** (rudra496/cnc) | Free, open-source (Three.js) | Real-time 3D material removal, G/M-code animation, DRO, tool library | Primarily milling | Closest modern free browser milling sim |
| **CutViewer** | Free | 3D toolpath, editor, pre-flight checks, job stats | Toolpath focus | Client-side, privacy-friendly |
| **UltraNC** | Free | Real-time simulation + accurate cycle time | Toolpath focus | Good kinematics modeling |
| **ASFAN CNC Studio** | Browser CAD/CAM + Sim | Design + toolpath generation + machine simulation | Yes | Supports mill, lathe, laser, etc. |
| **cncwebsim** | Free (older) | Toolpath + final 3D workpiece for Lathe/Mill/Printer | Yes | WebGL, Grbl-inspired |
| Others (NCPlayer, WebGCode 2, NCviewer) | Free | Viewing, editing, basic simulation | Limited | Useful for quick checks |

**Key observation:**  
High-fidelity free browser-based **horizontal lathe** simulators with progressive material removal, chips, and realistic kinematics remain relatively rare. Most free tools excel at milling toolpaths. This gap makes a custom Three.js lathe app particularly valuable.

---

## 4. Overall Takeaways

- Anatomy is excellent for beautiful, general-purpose, shareable technical explanations.
- A specialized 3D lathe simulator (AI only supplies geometry + process) is more efficient, realistic, and useful for actual CNC/machining education.
- Existing tools prove browser-based 3D machining simulation is feasible; a focused lathe version would fill a clear niche.
- Best long-term approach: hybrid systems that choose the right visualization method based on the user’s goal.