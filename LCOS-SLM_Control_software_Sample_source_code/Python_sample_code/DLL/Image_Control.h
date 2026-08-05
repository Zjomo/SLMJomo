#include "extcode.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef uint32_t  Enum;
#define Enum_Row 0
#define Enum_Column 1

/*!
 * AxiconLens
 */
void __stdcall AxiconLens(double TopLevelRad, 
	uint8_t PixelPitch0_20um_or_1_125um, int32_t X_pixel_target, 
	int32_t Y_pixel_target, int32_t *targetDataSize, uint8_t _1DArrayOut[]);
/*!
 * CylindricalLens
 */
void __stdcall CylindricalLens(int32_t CylindricalFocusMm, 
	uint32_t WaveLengthNm, uint8_t PixelPitch020um_or_1125um, Enum ModeSelect, 
	int32_t X_pixel_target, int32_t Y_pixel_target, int32_t *targetDataSize, 
	uint8_t _1DArrayOut[]);
/*!
 * This VI calculates a Fresnel Lens pattern and combine input 2D image.
 */
void __stdcall FresnelLens(int32_t FocusMm, int32_t WaveLengthNm, 
	uint8_t PixelPitch020um_or_1125um, int32_t X_pixel_target, 
	int32_t Y_pixel_target, int32_t *targetDataSize, uint8_t _1DArrayOut[]);
/*!
 * Rotates an image(8-bit 2D array).
 */
void __stdcall Image_Rotation(uint8_t _1DArrayIn[], double degree, 
	int32_t X_pixel_target, int32_t Y_pixel_target, int32_t *targetDataSize, 
	uint8_t _1DArrayOut[]);
/*!
 * A small image is tiled in arbitrary(LCOS-SLM) size.
 * This VI expands a small CGH image into LCOS-SLM size image. 
 */
void __stdcall Image_Tiling(uint8_t _1DArrayIn[], int32_t X_pixel_in, 
	int32_t Y_pixel_in, int32_t inputDataSize, int32_t X_pixel_target, 
	int32_t Y_pixel_target, int32_t *targetDataSize, uint8_t _1DArrayOut[]);
/*!
 * LaguerreGaussMode
 */
void __stdcall LaguerreGaussMode(uint32_t p, uint32_t m, 
	uint8_t PixelPitch020um_or_1125um, double BeamSizeMm, int32_t X_pixel_target, 
	int32_t Y_pixel_target, int32_t *targetDataSize, uint8_t _1DArrayOut[]);
/*!
 * Window_Settings
 */
void __stdcall Window_Settings(int32_t MonitorNumber, 
	int32_t WindowNumber015, int32_t XPixelShift, int32_t YPixelShift);
/*!
 * Window_Array_to_Display
 */
void __stdcall Window_Array_to_Display(uint8_t _1DArrayIn[], 
	int32_t X_pixel_in, int32_t Y_pixel_in, int32_t WindowNumber015, 
	int32_t targetDataSize);
/*!
 * Window_Term
 */
void __stdcall Window_Term(int32_t WindowNumber015);
/*!
 * Diffraction_pattern
 */
void __stdcall Diffraction_pattern(uint32_t Row0OrColumn1, 
	uint32_t gradationNumber, uint32_t gradationWidth, int32_t SlipFactor, 
	int32_t X_pixel_target, int32_t Y_pixel_target, int32_t *targetDataSize, 
	uint8_t _1DArrayOut[]);
/*!
 * Create_CGH_OC
 */
void __stdcall Create_CGH_OC(uint8_t _1DArrayIn[], uint32_t RepetitionNumber, 
	uint8_t progressBarOFF_0_ON_1, int32_t X_pixel_target, 
	int32_t Y_pixel_target, int32_t *targetDataSize, uint8_t _1DArrayOut[]);
/*!
 * Zernike
 */
void __stdcall Zernike(int32_t m, int32_t n, double beamDiameter_mm, 
	double Coeff, uint8_t PixelPitch0_20um_or_1_125um, int32_t X_pixel_target, 
	int32_t Y_pixel_target, int32_t *targetDataSize, uint8_t _1DArrayOut[]);

MgErr __cdecl LVDLLStatus(char *errStr, int errStrLen, void *module);

void __cdecl SetExcursionFreeExecutionSetting(Bool32 value);

#ifdef __cplusplus
} // extern "C"
#endif

